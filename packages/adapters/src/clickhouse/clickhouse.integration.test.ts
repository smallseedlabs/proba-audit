import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '@smallseedlabs/proba-audit-core';
import {
  makeObservation,
  makeStoredAuditEvent,
  runAuditStoreContract,
  runAuditContentStoreContract,
  runMetricsStoreContract,
  runCheckpointStoreContract,
  runQuarantineStoreContract,
} from '@smallseedlabs/proba-audit-core/testing';
import { createClickHouseClient, ensureDatabase, type ClickHouseOptions } from './client.js';
import { ClickHouseAuditStore } from './audit-store.js';
import { ClickHouseAuditContentStore } from './audit-content-store.js';
import { ClickHouseMetricsStore } from './metrics-store.js';
import { ClickHouseCheckpointStore, ClickHouseQuarantineStore } from './ingest-state-stores.js';
import { clickHouseMigrationDb } from './migrate-db.js';
import { loadMigrations, runMigrations } from './migrate.js';

const base = loadConfig(process.env).clickhouse;
const options = (database: string): ClickHouseOptions => ({ ...base, database });
const migrationsDir = resolve(__dirname, '../../../../migrations/clickhouse');

const TEST_DB = process.env.CLICKHOUSE_TEST_DATABASE ?? 'proba_audit_test';
const MIGRATION_DB = `${TEST_DB}_migrations`;

beforeAll(async () => {
  await ensureDatabase(options(TEST_DB));
  const client = createClickHouseClient(options(TEST_DB));
  await runMigrations(clickHouseMigrationDb(client), loadMigrations(migrationsDir));
  await client.close();
});

runAuditStoreContract('clickhouse', async () => ({
  store: new ClickHouseAuditStore({ client: createClickHouseClient(options(TEST_DB)), ownsClient: true }),
}));

runAuditContentStoreContract('clickhouse', async () => ({
  store: new ClickHouseAuditContentStore({ client: createClickHouseClient(options(TEST_DB)), ownsClient: true }),
}));

runMetricsStoreContract('clickhouse', async () => ({
  store: new ClickHouseMetricsStore({ client: createClickHouseClient(options(TEST_DB)), ownsClient: true }),
}));

runCheckpointStoreContract('clickhouse', async () => ({
  store: new ClickHouseCheckpointStore({ client: createClickHouseClient(options(TEST_DB)), ownsClient: true }),
}));

runQuarantineStoreContract('clickhouse', async () => ({
  store: new ClickHouseQuarantineStore({ client: createClickHouseClient(options(TEST_DB)), ownsClient: true }),
}));

describe('ClickHouse migrations', () => {
  const admin = () => createClickHouseClient(options('default'));

  beforeAll(async () => {
    const c = admin();
    await c.command({ query: `DROP DATABASE IF EXISTS ${MIGRATION_DB}` });
    await c.close();
    await ensureDatabase(options(MIGRATION_DB));
  });

  afterAll(async () => {
    const c = admin();
    await c.command({ query: `DROP DATABASE IF EXISTS ${MIGRATION_DB}` });
    await c.close();
  });

  it('applies all migrations to an empty database, then is a no-op', async () => {
    const client = createClickHouseClient(options(MIGRATION_DB));
    try {
      const db = clickHouseMigrationDb(client);
      const migrations = loadMigrations(migrationsDir);

      const first = await runMigrations(db, migrations);
      expect(first.applied).toHaveLength(9);
      const second = await runMigrations(db, migrations);
      expect(second.applied).toEqual([]);
      expect(second.skipped).toHaveLength(9);

      const rows = await (
        await client.query({ query: 'SELECT version, name FROM schema_migrations ORDER BY version', format: 'JSONEachRow' })
      ).json<{ version: number; name: string }>();
      expect(rows.map((r) => r.version)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);

      const tables = await (
        await client.query({
          query: 'SELECT name, engine FROM system.tables WHERE database = {db:String} ORDER BY name',
          query_params: { db: MIGRATION_DB },
          format: 'JSONEachRow',
        })
      ).json<{ name: string; engine: string }>();
      const daily = await (
        await client.query({
          query: "SELECT name, default_expression FROM system.columns WHERE database = {db:String} AND table = 'metric_rollups_daily' AND name IN ('timezone', 'bucket_date') ORDER BY name",
          query_params: { db: MIGRATION_DB },
          format: 'JSONEachRow',
        })
      ).json<{ name: string; default_expression: string }>();
      expect(daily.map((c) => c.name)).toEqual(['bucket_date', 'timezone']);
      expect(Object.fromEntries(tables.map((t) => [t.name, t.engine]))).toEqual({
        audit_event_content: 'ReplacingMergeTree',
        audit_events: 'MergeTree',
        ingest_checkpoints: 'ReplacingMergeTree',
        metric_observation_quarantine: 'MergeTree',
        metric_observations: 'ReplacingMergeTree',
        metric_rollups_daily: 'ReplacingMergeTree',
        metric_rollups_hourly: 'ReplacingMergeTree',
        schema_migrations: 'MergeTree',
      });
    } finally {
      await client.close();
    }
  });

  it('audit_events fsyncs every insert so an acknowledged event is durable', async () => {
    const client = createClickHouseClient(options(MIGRATION_DB));
    try {
      const [t] = await (
        await client.query({
          query: "SELECT create_table_query FROM system.tables WHERE database = {db:String} AND name = 'audit_events'",
          query_params: { db: MIGRATION_DB },
          format: 'JSONEachRow',
        })
      ).json<{ create_table_query: string }>();
      expect(t.create_table_query).toMatch(/fsync_after_insert = 1/);
      expect(t.create_table_query).toMatch(/fsync_part_directory = 1/);
    } finally {
      await client.close();
    }
  });

  it('audit_events is partitioned by month and ordered by (workspace_id, occurred_at, event_id)', async () => {
    const client = createClickHouseClient(options(MIGRATION_DB));
    try {
      const [t] = await (
        await client.query({
          query: 'SELECT partition_key, sorting_key FROM system.tables WHERE database = {db:String} AND name = \'audit_events\'',
          query_params: { db: MIGRATION_DB },
          format: 'JSONEachRow',
        })
      ).json<{ partition_key: string; sorting_key: string }>();
      expect(t.partition_key).toBe('toYYYYMM(occurred_at)');
      expect(t.sorting_key).toBe('workspace_id, occurred_at, event_id');
    } finally {
      await client.close();
    }
  });
});

describe('ClickHouse storage details', () => {
  it('stores audit events across month partitions', async () => {
    const store = new ClickHouseAuditStore({ client: createClickHouseClient(options(TEST_DB)), ownsClient: true });
    try {
      const workspaceId = `part-${Date.now()}`;
      await store.appendBatch([
        makeStoredAuditEvent({ workspaceId, occurredAt: '2026-09-30T23:59:59.999Z' }),
        makeStoredAuditEvent({ workspaceId, occurredAt: '2026-10-01T00:00:00.000Z' }),
      ]);
      const client = createClickHouseClient(options(TEST_DB));
      const parts = await (
        await client.query({
          query: "SELECT DISTINCT partition FROM system.parts WHERE database = {db:String} AND table = 'audit_events' AND active",
          query_params: { db: TEST_DB },
          format: 'JSONEachRow',
        })
      ).json<{ partition: string }>();
      await client.close();
      expect(parts.map((p) => p.partition)).toEqual(expect.arrayContaining(['202609', '202610']));
    } finally {
      await store.close();
    }
  });

  it('collapses restated observations to the highest revision after a merge', async () => {
    const client = createClickHouseClient(options(TEST_DB));
    const store = new ClickHouseMetricsStore({ client });
    const accountId = `merge-${Date.now()}`;
    await store.upsertObservations(`ws-${accountId}`, [makeObservation({ accountId, revision: 0 })]);
    await store.upsertObservations(`ws-${accountId}`, [makeObservation({ accountId, revision: 1 })]);
    await client.command({ query: 'OPTIMIZE TABLE metric_observations FINAL' });
    const rows = await (
      await client.query({
        query: 'SELECT revision FROM metric_observations WHERE account_id = {a:String}',
        query_params: { a: accountId },
        format: 'JSONEachRow',
      })
    ).json<{ revision: number }>();
    expect(rows.map((r) => Number(r.revision))).toEqual([1]);
    await client.close();
  });

  it('rejects a bad connection with a clear error on ping', async () => {
    const store = new ClickHouseAuditStore({
      client: createClickHouseClient({ ...base, url: 'http://127.0.0.1:1', database: TEST_DB }),
      ownsClient: true,
    });
    await expect(store.ping()).rejects.toBeDefined();
    await store.close();
  });
});

describe('ClickHouse roles (scripts/clickhouse-roles.sql)', () => {
  const ROLES_DB = `${TEST_DB}_roles`;
  const users = { consumer: 'proba_test_consumer', api: 'proba_test_api', migrator: 'proba_test_migrator' };
  const rolesFor = (user: string, password: string): ClickHouseOptions => ({ ...base, database: ROLES_DB, username: user, password });
  const admin = () => createClickHouseClient(options('default'));

  beforeAll(async () => {
    const c = admin();
    await c.command({ query: `DROP DATABASE IF EXISTS ${ROLES_DB}` });
    await c.close();
    await ensureDatabase(options(ROLES_DB));
    const client = createClickHouseClient(options(ROLES_DB));
    await runMigrations(clickHouseMigrationDb(client), loadMigrations(migrationsDir));
    // The production script, with test user names, a test database and test passwords.
    const sql = readFileSync(resolve(__dirname, '../../../../scripts/clickhouse-roles.sql'), 'utf8')
      .replace(/--.*$/gm, '')
      .replaceAll('proba_audit.', `${ROLES_DB}.`)
      .replaceAll('proba_consumer', users.consumer)
      .replaceAll('proba_api', users.api)
      .replaceAll('proba_migrator', users.migrator)
      .replace('__CONSUMER_PASSWORD__', 'consumer-pw')
      .replace('__API_PASSWORD__', 'api-pw')
      .replace('__MIGRATOR_PASSWORD__', 'migrator-pw');
    for (const statement of sql.split(';').map((x) => x.trim()).filter(Boolean)) await client.command({ query: statement });
    await client.close();
  });

  afterAll(async () => {
    const c = admin();
    await c.command({ query: `DROP DATABASE IF EXISTS ${ROLES_DB}` });
    for (const u of Object.values(users)) await c.command({ query: `DROP USER IF EXISTS ${u}` });
    await c.close();
  });

  it('the consumer role writes and reads audit and metrics data, including rollups', async () => {
    const o = rolesFor(users.consumer, 'consumer-pw');
    const audit = new ClickHouseAuditStore({ client: createClickHouseClient(o), ownsClient: true });
    const metrics = new ClickHouseMetricsStore({ client: createClickHouseClient(o), ownsClient: true });
    const checkpoints = new ClickHouseCheckpointStore({ client: createClickHouseClient(o), ownsClient: true });
    try {
      const workspaceId = `roles-${Date.now()}`;
      const event = makeStoredAuditEvent({ workspaceId });
      await audit.appendBatch([event]);
      expect((await audit.getChainHead(workspaceId))?.hash).toBe(event.hash);

      const observation = makeObservation({ accountId: 'roles-acc' });
      await metrics.upsertObservations(workspaceId, [observation]);
      const changed = await metrics.changedSince(workspaceId);
      expect(changed).not.toBeNull();
      const rolled = await metrics.computeRollups({ workspaceId, bucket: 'hour', from: changed!.from, to: changed!.to });
      expect(rolled).toBeGreaterThan(0);

      const key = { workspaceId, source: 'meta', accountId: 'a', stream: 'hour' };
      await checkpoints.set(key, { cursor: 'c', runId: 'r' });
      expect((await checkpoints.get(key))?.cursor).toBe('c');
    } finally {
      await Promise.all([audit.close(), metrics.close(), checkpoints.close()]);
    }
  });

  it('the consumer role cannot rewrite, truncate or drop the audit trail', async () => {
    const client = createClickHouseClient(rolesFor(users.consumer, 'consumer-pw'));
    try {
      for (const query of [
        'ALTER TABLE audit_events UPDATE action = \'x\' WHERE 1',
        'ALTER TABLE audit_events DELETE WHERE 1',
        'TRUNCATE TABLE audit_events',
        'DROP TABLE audit_events',
        'CREATE TABLE intruder (a UInt8) ENGINE = Memory',
      ]) {
        await expect(client.command({ query }), query).rejects.toThrow(/Not enough privileges|ACCESS_DENIED/);
      }
    } finally {
      await client.close();
    }
  });

  it('the api role reads but cannot write anything', async () => {
    const o = rolesFor(users.api, 'api-pw');
    const audit = new ClickHouseAuditStore({ client: createClickHouseClient(o), ownsClient: true });
    const metrics = new ClickHouseMetricsStore({ client: createClickHouseClient(o), ownsClient: true });
    try {
      await expect(audit.readChain(`nobody-${Date.now()}`, { order: 'asc', limit: 1 })).resolves.toEqual([]);
      await expect(metrics.getFreshness(`nobody-${Date.now()}`, [])).resolves.toBeDefined();
      await expect(audit.appendBatch([makeStoredAuditEvent()])).rejects.toThrow(/Not enough privileges|ACCESS_DENIED/);
      await expect(metrics.upsertObservations('ws', [makeObservation()])).rejects.toThrow(/Not enough privileges|ACCESS_DENIED/);
    } finally {
      await Promise.all([audit.close(), metrics.close()]);
    }
  });

  it('the migrator role applies migrations', async () => {
    const o = rolesFor(users.migrator, 'migrator-pw');
    const client = createClickHouseClient(o);
    try {
      const result = await runMigrations(clickHouseMigrationDb(client), loadMigrations(migrationsDir));
      expect(result.applied).toEqual([]);
      await client.command({ query: 'CREATE TABLE IF NOT EXISTS migrator_probe (a UInt8) ENGINE = Memory' });
      await client.command({ query: 'DROP TABLE migrator_probe' });
    } finally {
      await client.close();
    }
  });
});
