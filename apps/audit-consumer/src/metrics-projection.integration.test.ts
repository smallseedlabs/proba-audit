/**
 * Ads metric events on the real Redis stream, projected by the audit-consumer into
 * ClickHouse (proba_audit_test only). Does not drop shared volumes, does not call
 * an ad platform, does not use the live `proba_audit` database.
 */
import { resolve } from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig, MetricsAnalytics, replayMetricsFromAudit } from '@smallseedlabs/proba-audit-core';
import { makeAdsMetricsIngestedEvent, makeAdsObservation, uniqueName } from '@smallseedlabs/proba-audit-core/testing';
import {
  ClickHouseAuditStore,
  ClickHouseMetricsStore,
  ClickHouseQuarantineStore,
  RandomIdGenerator,
  RedisStreamsEventBus,
  SystemClock,
  clickHouseMigrationDb,
  createClickHouseClient,
  ensureDatabase,
  loadMigrations,
  runMigrations,
  type ClickHouseOptions,
} from '@smallseedlabs/proba-audit-adapters';
import { ConsumerHarness } from './harness.testing.js';

const config = loadConfig(process.env);
const chOptions: ClickHouseOptions = { ...config.clickhouse, database: process.env.CLICKHOUSE_TEST_DATABASE ?? 'proba_audit_test' };
const migrationsDir = resolve(__dirname, '../../../migrations/clickhouse');

beforeAll(async () => {
  await ensureDatabase(chOptions);
  const client = createClickHouseClient(chOptions);
  await runMigrations(clickHouseMigrationDb(client), loadMigrations(migrationsDir));
  await client.close();
});

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (closers.length) await closers.pop()!();
});

describe('Ads metrics.ingested → ClickHouse (isolated test database)', () => {
  it('projects, dedupes a redelivery, maps the proba campaign, and is queryable', async () => {
    const workspaceId = uniqueName('ws');
    const topic = uniqueName('topic');
    const group = uniqueName('group');
    const bus = new RedisStreamsEventBus({ url: config.eventBus.redisUrl });
    const auditStore = new ClickHouseAuditStore({ client: createClickHouseClient(chOptions), ownsClient: true });
    const metricsStore = new ClickHouseMetricsStore({ client: createClickHouseClient(chOptions), ownsClient: true });
    const quarantine = new ClickHouseQuarantineStore({ client: createClickHouseClient(chOptions), ownsClient: true });
    const clock = new SystemClock();
    const ids = new RandomIdGenerator();
    const h = new ConsumerHarness({
      bus,
      store: auditStore,
      metricsStore,
      quarantine,
      clock,
      ids,
      topic,
      group,
      selfAudit: false,
      overrides: { blockMs: 100 },
    });
    closers.push(async () => {
      await h.close();
      await Promise.allSettled([bus.close(), auditStore.close(), metricsStore.close(), quarantine.close()]);
    });

    const event = makeAdsMetricsIngestedEvent({
      workspaceId,
      observation: makeAdsObservation({ accountId: uniqueName('act') }),
    });
    await bus.publish(topic, event);
    await h.pump();

    const accountId = event.details.accountId as string;
    const rows = await metricsStore.queryObservations({ workspaceId, accountId });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.metrics.impressions).toBe(9);
    expect(rows[0]?.campaignId).toBe('cmp_metrics');
    expect(await metricsStore.listAccounts(workspaceId)).toEqual([{ platform: 'reddit', accountId }]);
    expect(await metricsStore.resolveCampaignIds(workspaceId, ['11111111-1111-4111-8111-111111111111'])).toEqual(['cmp_metrics']);

    await bus.publish(topic, event);
    await h.pump();
    expect(await metricsStore.queryObservations({ workspaceId, accountId })).toHaveLength(1);

    await metricsStore.computeRollups({
      workspaceId,
      bucket: 'day',
      from: '2026-11-01T00:00:00.000Z',
      to: '2026-11-02T00:00:00.000Z',
    });
    const analytics = new MetricsAnalytics(metricsStore);
    const summary = await analytics.getMetricsSummary(
      { workspaceId, accounts: [{ platform: 'reddit', accountId }] },
      { granularity: 'day', from: '2026-11-01T00:00:00.000Z', to: '2026-11-02T00:00:00.000Z' }
    );
    expect(summary.totals[0]?.impressions).toBe(9);

    const byProba = await analytics.getMetricsSummary(
      { workspaceId, accounts: [{ platform: 'reddit', accountId }] },
      {
        granularity: 'day',
        from: '2026-11-01T00:00:00.000Z',
        to: '2026-11-02T00:00:00.000Z',
        campaignId: '11111111-1111-4111-8111-111111111111',
      }
    );
    expect(byProba.totals[0]?.impressions).toBe(9);

    const replayed = await replayMetricsFromAudit(
      auditStore,
      { metricsStore, quarantine, ids, clock },
      { workspaceId }
    );
    expect(replayed.scanned).toBeGreaterThanOrEqual(1);
    expect(await metricsStore.queryObservations({ workspaceId, accountId })).toHaveLength(1);
  });
});
