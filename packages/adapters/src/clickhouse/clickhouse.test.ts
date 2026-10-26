import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { makeObservation, makeStoredAuditEvent } from '@smallseedlabs/proba-audit-core/testing';
import { buildAggregateSql, buildAuditWhere, fromRow, toRow } from './audit-store.js';
import { fromContentRow, toContentRow } from './audit-content-store.js';
import { fromObservationRow, toObservationRow } from './metrics-store.js';
import {
  loadMigrations,
  runMigrations,
  splitStatements,
  type AppliedMigration,
  type MigrationDb,
} from './migrate.js';

const migrationsDir = resolve(__dirname, '../../../../migrations/clickhouse');

function fakeDb(applied: AppliedMigration[] = []) {
  const commands: string[] = [];
  const recorded: AppliedMigration[] = [];
  const db: MigrationDb = {
    async command(sql) {
      commands.push(sql);
    },
    async listApplied() {
      return applied;
    },
    async recordApplied(m) {
      recorded.push(m);
    },
  };
  return { db, commands, recorded };
}

describe('row mapping', () => {
  it('round-trips a full audit event', () => {
    const e = makeStoredAuditEvent({
      userId: '770e8400-e29b-41d4-a716-446655440000',
      campaignId: 'c1',
      parentSpanId: 'aaaaaaaaaaaaaaaa',
      target: { type: 'goal', id: 'g' },
      errorCode: 'E',
      errorMessage: 'm',
      riskLevel: 'low',
      cost: { tokensIn: 1, tokensOut: 2, currency: 'USD', amount: 0.5 },
      durationMs: 12,
      tags: ['a'],
      details: { n: { x: 1 } },
    });
    expect(fromRow(toRow(e))).toEqual(e);
  });

  it('maps absent optionals to null and back to absent', () => {
    const e = makeStoredAuditEvent();
    const row = toRow(e);
    expect(row.user_id).toBeNull();
    expect(row.cost_amount).toBeNull();
    expect(row.tags).toEqual([]);
    expect(fromRow(row)).toEqual(e);
  });

  it('round-trips observations; campaign level rows use empty adset/ad ids', () => {
    const campaignLevel = makeObservation();
    expect(toObservationRow('ws_1', campaignLevel)).toMatchObject({ workspace_id: 'ws_1', adset_id: '', ad_id: '', reach: null, timezone: null });
    expect(fromObservationRow(toObservationRow('ws_1', campaignLevel))).toEqual(campaignLevel);
    const full = makeObservation({ adsetId: 'as', adId: 'ad', timezone: 'Europe/London', sourceRef: 's', metrics: { impressions: 1, clicks: 1, spend: 1, conversions: 1, reach: 1, videoViews: 1, revenue: 1 } });
    expect(fromObservationRow(toObservationRow('ws_1', full))).toEqual(full);
  });
});

describe('SQL building', () => {
  it('binds every filter value as a parameter (no interpolation)', () => {
    const w = buildAuditWhere({ workspaceId: "w'; DROP TABLE audit_events; --", category: 'brain', from: '2026-10-25T00:00:00.000Z' });
    expect(w.sql).not.toContain('DROP');
    expect(w.sql).toContain('workspace_id = {workspaceId:String}');
    expect(w.sql).toContain('category = {category:String}');
    expect(w.sql).toContain('occurred_at >=');
    expect(w.params.workspaceId).toContain('DROP');
  });

  it('builds no WHERE for an empty filter', () => {
    expect(buildAuditWhere({}).sql).toBe('');
  });

  it('groups aggregates by the requested keys only', () => {
    const q = buildAggregateSql({ filter: { workspaceId: 'w' }, groupBy: ['category', 'hour'] });
    expect(q.sql).toContain('GROUP BY k0, k1');
    expect(buildAggregateSql({ filter: {}, groupBy: [] }).sql).not.toContain('GROUP BY');
  });
});

describe('migration runner', () => {
  it('splits statements and drops comment lines', () => {
    expect(splitStatements('-- c\nCREATE TABLE a (x Int8);\n\n-- d\nCREATE TABLE b (y Int8);\n')).toEqual([
      'CREATE TABLE a (x Int8)',
      'CREATE TABLE b (y Int8)',
    ]);
  });

  it('loads the real migrations in order with checksums', () => {
    const m = loadMigrations(migrationsDir);
    expect(m.map((x) => x.filename)).toEqual([
      '0001_audit_events.sql',
      '0002_metric_observations.sql',
      '0003_metric_rollups.sql',
      '0004_audit_events_durability.sql',
      '0005_ingest_state.sql',
      '0006_rollup_timezone.sql',
      '0007_audit_read_indexes.sql',
      '0008_audit_event_content.sql',
      '0009_metrics_workspace.sql',
    ]);
    expect(m.map((x) => x.statements.length)).toEqual([1, 1, 2, 1, 2, 2, 8, 2, 12]);
    expect(new Set(m.map((x) => x.checksum)).size).toBe(9);
  });

  it('keeps every statement idempotent', () => {
    // 0009 rebuilds tables (copy, swap, drop) and cannot be re-run after the swap; its header says how to recover.
    for (const m of loadMigrations(migrationsDir).filter((x) => x.version !== 9)) {
      for (const s of m.statements) expect(s).toMatch(/^(CREATE (TABLE|DATABASE) IF NOT EXISTS|ALTER TABLE \w+ (MODIFY SETTING|ADD COLUMN IF NOT EXISTS|ADD INDEX IF NOT EXISTS|MATERIALIZE INDEX))/);
    }
  });

  it('applies pending migrations in order and records them', async () => {
    const { db, commands, recorded } = fakeDb();
    const result = await runMigrations(db, loadMigrations(migrationsDir));
    expect(result.applied).toHaveLength(9);
    expect(commands).toHaveLength(31);
    expect(recorded.map((r) => r.version)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it('skips applied migrations and only runs new ones', async () => {
    const all = loadMigrations(migrationsDir);
    const { db, commands, recorded } = fakeDb([{ version: 1, name: all[0].name, checksum: all[0].checksum }]);
    const result = await runMigrations(db, all);
    expect(result.skipped).toEqual(['0001_audit_events.sql']);
    expect(result.applied).toEqual([
      '0002_metric_observations.sql',
      '0003_metric_rollups.sql',
      '0004_audit_events_durability.sql',
      '0005_ingest_state.sql',
      '0006_rollup_timezone.sql',
      '0007_audit_read_indexes.sql',
      '0008_audit_event_content.sql',
      '0009_metrics_workspace.sql',
    ]);
    expect(commands).toHaveLength(30);
    expect(recorded.map((r) => r.version)).toEqual([2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it('refuses to continue when an applied migration was edited', async () => {
    const all = loadMigrations(migrationsDir);
    const { db, commands } = fakeDb([{ version: 1, name: all[0].name, checksum: 'different' }]);
    await expect(runMigrations(db, all)).rejects.toThrow(/contents changed/);
    expect(commands).toHaveLength(0);
  });

  it('rejects badly named or non-sequential files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mig-'));
    writeFileSync(join(dir, '0002_skip.sql'), 'SELECT 1;');
    expect(() => loadMigrations(dir)).toThrow(/sequential/);
    const bad = mkdtempSync(join(tmpdir(), 'mig-'));
    writeFileSync(join(bad, 'create.sql'), 'SELECT 1;');
    expect(() => loadMigrations(bad)).toThrow(/Invalid migration filename/);
  });
});

describe('audit_event_content rows', () => {
  it('round-trips the text with its metadata and digest', () => {
    const item = {
      workspaceId: 'seedbed',
      eventId: '22222222-2222-4222-8222-222222222222',
      occurredAt: '2026-10-25T10:00:00.000Z',
      content: { kind: 'brain_reply', text: 'Done \u{1F600}', truncated: true, originalLength: 20000, redactions: 2 },
      contentDigest: 'a'.repeat(64),
    };
    const row = toContentRow(item);
    expect(row).toMatchObject({ workspace_id: 'seedbed', truncated: 1, original_length: 20000, redactions: 2, content_digest: 'a'.repeat(64) });
    expect(fromContentRow({ ...row, truncated: Number(row.truncated), original_length: String(row.original_length) as unknown as number })).toEqual(item);
  });

  it('keeps the digest column on audit_events rows, and none for events without text', () => {
    const withText = makeStoredAuditEvent({ contentDigest: 'b'.repeat(64) });
    expect(fromRow(toRow(withText)).contentDigest).toBe('b'.repeat(64));
    expect(fromRow(toRow(makeStoredAuditEvent())).contentDigest).toBeUndefined();
  });
});

describe('migration 0008', () => {
  it('keeps the text in its own table, apart from audit_events', () => {
    const m = loadMigrations(migrationsDir).find((x) => x.filename === '0008_audit_event_content.sql')!;
    const sql = m.statements.join('\n');
    expect(sql).toMatch(/ALTER TABLE audit_events ADD COLUMN IF NOT EXISTS content_digest/);
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS audit_event_content/);
    expect(sql).toMatch(/ORDER BY \(workspace_id, event_id\)/);
    expect(sql).toMatch(/PARTITION BY toYYYYMM\(occurred_at\)/);
  });
});

describe('migration 0009', () => {
  const sql = loadMigrations(migrationsDir).find((x) => x.filename === '0009_metrics_workspace.sql')!.statements.join('\n');

  it.each(['metric_observations', 'metric_rollups_hourly', 'metric_rollups_daily'])('rebuilds %s with workspace_id leading the sorting key', (table) => {
    expect(sql).toMatch(new RegExp(`CREATE TABLE IF NOT EXISTS ${table}_ws`));
    expect(sql).toMatch(new RegExp(`INSERT INTO ${table}_ws[\\s\\S]*?SELECT 'seedbed'[\\s\\S]*?FROM ${table}`));
    expect(sql).toMatch(new RegExp(`EXCHANGE TABLES ${table} AND ${table}_ws`));
    expect(sql).toMatch(new RegExp(`DROP TABLE ${table}_ws`));
  });

  it('puts workspace_id first in every new sorting key and gives it no default', () => {
    const keys = sql.match(/ORDER BY \([^)]*\)/g) ?? [];
    expect(keys).toHaveLength(3);
    for (const k of keys) expect(k).toMatch(/^ORDER BY \(workspace_id, platform,/);
    expect(sql).not.toMatch(/workspace_id\s+String\s+DEFAULT/);
  });

  it('copies inserted_at and computed_at so the rollup watermark does not rewind', () => {
    expect(sql).toMatch(/INSERT INTO metric_observations_ws[\s\S]*inserted_at\)[\s\S]*inserted_at\s+FROM metric_observations/);
    expect(sql).toMatch(/computed_at(, timezone, bucket_date)?\s+FROM metric_rollups_hourly/);
  });
});
