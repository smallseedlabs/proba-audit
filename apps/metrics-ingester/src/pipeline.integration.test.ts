/**
 * The metrics flow against the real services: the stub connector, the ingest engine,
 * the rollup worker and the analytics reader on ClickHouse (observations, rollups,
 * checkpoints, quarantine), and the audit events over Redis Streams through the real
 * audit-consumer into the ClickHouse audit store. Every test uses its own accounts and
 * workspace, so one shared stack can run them all.
 */
import { resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  AuditedAnalyticsReader,
  MetricsAnalytics,
  createBusAuditEmitter,
  loadConfig,
  type AnalyticsScope,
  type FetchWindow,
  type MetricObservation,
  type MetricsStore,
} from '@smallseedlabs/proba-audit-core';
import { uniqueName } from '@smallseedlabs/proba-audit-core/testing';
import {
  ClickHouseAuditStore,
  ClickHouseCheckpointStore,
  ClickHouseMetricsStore,
  ClickHouseQuarantineStore,
  ManualClock,
  RandomIdGenerator,
  RedisStreamsEventBus,
  StubConnectorNotAllowedError,
  StubPlatformConnector,
  clickHouseMigrationDb,
  createClickHouseClient,
  createConnectors,
  ensureDatabase,
  loadMigrations,
  runMigrations,
  type ClickHouseOptions,
} from '@smallseedlabs/proba-audit-adapters';
import { MemoryLogger } from '@smallseedlabs/proba-audit-core';
import { ConsumerHarness } from '../../audit-consumer/src/harness.testing.js';
import { RollupWorker } from '../../rollup/src/rollup-worker.js';
import { SyncEngine } from './sync-engine.js';

const config = loadConfig(process.env);
const chOptions: ClickHouseOptions = { ...config.clickhouse, database: process.env.CLICKHOUSE_TEST_DATABASE ?? 'proba_audit_test' };
const migrationsDir = resolve(__dirname, '../../../migrations/clickhouse');
const HOUR = 3_600_000;
const T0 = '2026-10-28T12:00:00.000Z';

beforeAll(async () => {
  await ensureDatabase(chOptions);
  const client = createClickHouseClient(chOptions);
  await runMigrations(clickHouseMigrationDb(client), loadMigrations(migrationsDir));
  await client.close();
});

/** Real time, but never the same millisecond twice: events of one run then keep their order in the audit store. */
function tickingClock() {
  let last = Date.now();
  const next = () => (last = Math.max(last + 1, Date.now()));
  return { now: () => new Date(next()), isoNow: () => new Date(next()).toISOString() };
}

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (closers.length) await closers.pop()!();
});
afterAll(async () => {
  await Promise.all(closers.splice(0).map((c) => c()));
});

/** A fresh set of ClickHouse-backed stores on new connections (a "process"). */
function stores(clock: ManualClock) {
  const metrics = new ClickHouseMetricsStore({ client: createClickHouseClient(chOptions), ownsClient: true });
  const checkpoints = new ClickHouseCheckpointStore({ client: createClickHouseClient(chOptions), clock, ownsClient: true });
  const quarantine = new ClickHouseQuarantineStore({ client: createClickHouseClient(chOptions), ownsClient: true });
  closers.push(async () => {
    await Promise.allSettled([metrics.close(), checkpoints.close(), quarantine.close()]);
  });
  return { metrics, checkpoints, quarantine };
}

interface World {
  workspaceId: string;
  accountId: string;
  clock: ManualClock;
  connector: StubPlatformConnector;
  sleeps: number[];
  logger: MemoryLogger;
  s: ReturnType<typeof stores>;
  engine: (over?: { metrics?: MetricsStore; s?: ReturnType<typeof stores>; maxAttempts?: number; emitter?: ReturnType<typeof createBusAuditEmitter> }) => SyncEngine;
  rollup: () => RollupWorker;
  scope: AnalyticsScope;
  analytics: MetricsAnalytics;
}

/** Rows physically present in metric_observations (no FINAL): proves a pull wrote nothing. */
async function physicalRows(w: World): Promise<number> {
  const client = createClickHouseClient(chOptions);
  try {
    const rs = await client.query({
      query: 'SELECT count() AS n FROM metric_observations WHERE account_id = {a:String}',
      query_params: { a: w.accountId },
      format: 'JSONEachRow',
    });
    const [row] = await rs.json<{ n: string }>();
    return Number(row.n);
  } finally {
    await client.close();
  }
}

const ACCOUNT_TZ = 'Asia/Kolkata';

async function world(options: { timezone?: string; restateRevisions?: number; emitter?: ReturnType<typeof createBusAuditEmitter> } = {}): Promise<World> {
  const workspaceId = uniqueName('ws');
  const accountId = uniqueName('acct');
  const clock = new ManualClock(T0);
  const logger = new MemoryLogger();
  const sleeps: number[] = [];
  const connector = new StubPlatformConnector({
    platform: 'meta',
    clock,
    nodeEnv: 'test',
    restateEveryMinutes: 30,
    restateRevisions: options.restateRevisions ?? 2,
    accounts: [{ accountId, name: 'Integration account', timezone: options.timezone ?? ACCOUNT_TZ, currency: 'INR', campaigns: 2 }],
  });
  const s = stores(clock);
  const ids = new RandomIdGenerator();
  const engine: World['engine'] = (over = {}) =>
    new SyncEngine({
      metricsStore: over.metrics ?? (over.s ?? s).metrics,
      checkpoints: (over.s ?? s).checkpoints,
      quarantine: (over.s ?? s).quarantine,
      emitter: over.emitter ?? options.emitter,
      clock,
      ids,
      logger,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      random: () => 1,
      options: {
        workspaceId,
        serviceName: 'metrics-ingester',
        granularity: 'hour',
        initialLookbackHours: 48,
        pageSize: 100,
        retry: { maxAttempts: over.maxAttempts ?? 3, baseMs: 100, maxMs: 1000, maxRateLimitWaitMs: 10_000 },
      },
    });
  // Start rollups from "now": rows other tests left in the shared database are not ours to recompute.
  const baseline = await s.metrics.changedSince();
  if (baseline) await s.checkpoints.set({ workspaceId, source: 'rollup', accountId: '*', stream: 'changed_since' }, { cursor: baseline.watermark, runId: 'baseline' });
  const rollup = () =>
    new RollupWorker({
      metricsStore: s.metrics,
      checkpoints: s.checkpoints,
      clock,
      ids,
      logger,
      options: { workspaceId, serviceName: 'rollup', intervalMs: 1000, maxWindowDays: 7 },
    });
  const scope: AnalyticsScope = { workspaceId, accounts: [{ platform: 'meta', accountId }] };
  return { workspaceId, accountId, clock, connector, sleeps, logger, s, engine, rollup, scope, analytics: new MetricsAnalytics(s.metrics) };
}

/** What the platform reports right now for the whole range, pulled without a cursor (the independent truth). */
async function platformTruth(w: World, from: string, to: string): Promise<MetricObservation[]> {
  const window: FetchWindow = { from, to, granularity: 'hour' };
  const out: MetricObservation[] = [];
  let pageToken: string | undefined;
  do {
    const page = await w.connector.fetchObservations({ accountId: w.accountId }, { window, pageToken, pageSize: 1000 });
    out.push(...page.observations);
    pageToken = page.nextPageToken;
  } while (pageToken !== undefined);
  return out;
}

const total = (rows: MetricObservation[]) => ({
  impressions: rows.reduce((a, o) => a + o.metrics.impressions, 0),
  clicks: rows.reduce((a, o) => a + o.metrics.clicks, 0),
  spend: rows.reduce((a, o) => a + o.metrics.spend, 0),
  conversions: rows.reduce((a, o) => a + o.metrics.conversions, 0),
});

const stored = (w: World) => w.s.metrics.queryObservations({ platform: 'meta', accountId: w.accountId, granularity: 'hour', limit: 10_000 });

async function rolledUpTotals(w: World, bucket: 'hour' | 'day') {
  const [agg] = await w.s.metrics.aggregateRollups({
    bucket,
    from: '2026-10-20T00:00:00.000Z',
    to: '2026-11-05T00:00:00.000Z',
    groupBy: [],
    accounts: w.scope.accounts,
    sourceGranularity: 'hour',
  });
  return agg;
}

function expectTotals(actual: { impressions: number; clicks: number; spend: number; conversions: number }, expected: ReturnType<typeof total>): void {
  expect(actual.impressions).toBe(expected.impressions);
  expect(actual.clicks).toBe(expected.clicks);
  expect(actual.spend).toBeCloseTo(expected.spend, 4);
  expect(actual.conversions).toBeCloseTo(expected.conversions, 4);
}

describe('metrics flow on ClickHouse: stub -> ingest -> rollup -> read', () => {
  it('ingests incrementally, then a restatement replaces (not adds to) the earlier revision in every rollup', async () => {
    const w = await world();
    const engine = w.engine();
    const rollup = w.rollup();

    const first = await engine.syncAccount(w.connector, { accountId: w.accountId });
    expect(first).toMatchObject({ status: 'completed', quarantined: 0 });
    expect(first.ingested).toBeGreaterThan(100);
    await rollup.runOnce();
    const truth0 = total(await platformTruth(w, '2026-10-26T12:00:00.000Z', T0));
    expectTotals(total(await stored(w)), truth0);
    expectTotals((await rolledUpTotals(w, 'hour')).metrics, truth0);
    expectTotals((await rolledUpTotals(w, 'day')).metrics, truth0);

    // 45 minutes later the platform has restated recent hours and one new hour has completed.
    w.clock.advance(HOUR + 45 * 60_000);
    const second = await engine.syncAccount(w.connector, { accountId: w.accountId });
    expect(second.ingested).toBeGreaterThan(0);
    expect(second.restated).toBeGreaterThan(0);
    expect(second.received).toBeLessThan(first.received / 4); // incremental: not the whole window again
    const run = await rollup.runOnce();
    expect(run.status).toBe('completed');

    const truth1 = total(await platformTruth(w, '2026-10-26T12:00:00.000Z', '2026-10-28T13:00:00.000Z'));
    expect(truth1.conversions).toBeGreaterThan(truth0.conversions); // restatements moved the numbers
    expectTotals(total(await stored(w)), truth1);
    expectTotals((await rolledUpTotals(w, 'hour')).metrics, truth1);
    expectTotals((await rolledUpTotals(w, 'day')).metrics, truth1);
    expect((await stored(w)).some((o) => o.revision > 0)).toBe(true);
    expect((await stored(w)).every((o) => o.sourceRef?.startsWith('stub:'))).toBe(true);

    // The read side agrees with the independent sum.
    const summary = await w.analytics.getMetricsSummary(w.scope, { granularity: 'day', from: '2026-10-26T00:00:00.000Z', to: '2026-10-30T00:00:00.000Z' });
    expect(summary.totals).toHaveLength(1);
    expect(summary.totals[0].currency).toBe('INR');
    expect(summary.totals[0].impressions).toBe(truth1.impressions);
    expect(summary.totals[0].spend).toBeCloseTo(truth1.spend, 4);
    expect(summary.campaigns).toHaveLength(2);
  });

  it('pulling the same window twice changes nothing and triggers no new rollup', async () => {
    const w = await world();
    const engine = w.engine();
    const rollup = w.rollup();
    await engine.syncAccount(w.connector, { accountId: w.accountId });
    await rollup.runOnce();
    const before = await stored(w);
    const dayBefore = await rolledUpTotals(w, 'day');
    const physicalBefore = await physicalRows(w);

    await w.s.checkpoints.delete({ workspaceId: w.workspaceId, source: 'meta', accountId: w.accountId, stream: 'hour' });
    const again = await engine.syncAccount(w.connector, { accountId: w.accountId });
    expect(again).toMatchObject({ status: 'completed', ingested: 0, restated: 0, quarantined: 0 });
    expect(again.unchanged).toBe(before.length);
    expect(await stored(w)).toEqual(before);
    // No physical rows were added either: the second pull wrote nothing.
    expect(await physicalRows(w)).toBe(physicalBefore);
    await rollup.runOnce();
    const dayAfter = await rolledUpTotals(w, 'day');
    expectTotals(dayAfter.metrics, dayBefore.metrics); // float sums may differ in the last bits, nothing more
    expect(dayAfter.observationCount).toBe(dayBefore.observationCount);
  });

  it('rollups are cut in the account timezone: days follow local midnight, not UTC', async () => {
    const w = await world({ timezone: 'Australia/Sydney' });
    await w.engine().syncAccount(w.connector, { accountId: w.accountId });
    await w.rollup().runOnce();
    const rows = await stored(w);
    const localDate = (iso: string) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Sydney' }).format(new Date(iso));
    const expected = new Map<string, number>();
    for (const o of rows) expected.set(localDate(o.periodStart), (expected.get(localDate(o.periodStart)) ?? 0) + o.metrics.impressions);
    const days = await w.s.metrics.aggregateRollups({
      bucket: 'day',
      from: '2026-10-20T00:00:00.000Z',
      to: '2026-11-05T00:00:00.000Z',
      groupBy: ['bucket'],
      accounts: w.scope.accounts,
    });
    expect(new Map(days.map((d) => [d.bucket as string, d.metrics.impressions]))).toEqual(expected);
    expect(expected.size).toBeGreaterThanOrEqual(2);
    const dailyRows = await w.s.metrics.queryRollups({ bucket: 'day', accountId: w.accountId });
    expect(dailyRows.every((r) => r.timezone === 'Australia/Sydney')).toBe(true);
    // Local midnight in Sydney is not a UTC midnight.
    expect(dailyRows.some((r) => !r.bucketStart.endsWith('T00:00:00.000Z'))).toBe(true);
    expect(JSON.stringify(dailyRows)).not.toContain('reach');
  });

  it('retries transient failures with backoff and honours a rate-limit hint, on the real stores', async () => {
    const w = await world();
    const engine = w.engine({ maxAttempts: 4 });
    w.connector.injectFault({ kind: 'transient' }, 2);
    w.connector.injectFault({ kind: 'rate_limit', retryAfterMs: 3000 }, 1);
    const out = await engine.syncAccount(w.connector, { accountId: w.accountId });
    expect(out.status).toBe('completed');
    expect(w.sleeps).toEqual([100, 200, 3000]);

    // Exhausted retries: failed run, checkpoint untouched, next run recovers.
    const key = { workspaceId: w.workspaceId, source: 'meta', accountId: w.accountId, stream: 'hour' };
    const checkpoint = await w.s.checkpoints.get(key);
    w.clock.advance(HOUR);
    w.connector.injectFault({ kind: 'transient' }, 4);
    const failed = await engine.syncAccount(w.connector, { accountId: w.accountId });
    expect(failed).toMatchObject({ status: 'failed', error: { code: 'transient', attempts: 4 } });
    expect(await w.s.checkpoints.get(key)).toEqual(checkpoint);
    const recovered = await engine.syncAccount(w.connector, { accountId: w.accountId });
    expect(recovered.status).toBe('completed');
    expectTotals(total(await stored(w)), total(await platformTruth(w, '2026-10-26T12:00:00.000Z', '2026-10-28T13:00:00.000Z')));

    // A rate limit that asks for longer than the engine waits ends the run and tells the scheduler.
    w.connector.injectFault({ kind: 'rate_limit', retryAfterMs: 90_000 }, 1);
    w.clock.advance(HOUR);
    const limited = await engine.syncAccount(w.connector, { accountId: w.accountId });
    expect(limited).toMatchObject({ status: 'failed', retryAfterMs: 90_000 });
  });

  it('quarantines invalid observations with the reason and keeps them out of the metrics tables', async () => {
    const w = await world();
    w.connector.corruptNext('negative_spend', 3);
    const out = await w.engine().syncAccount(w.connector, { accountId: w.accountId });
    expect(out).toMatchObject({ status: 'completed', quarantined: 3 });
    const rows = await stored(w);
    expect(rows).toHaveLength(out.received - 3);
    expect(rows.every((o) => o.metrics.spend >= 0)).toBe(true);
    const q = await w.s.quarantine.list({ workspaceId: w.workspaceId });
    expect(q).toHaveLength(3);
    expect(q[0]).toMatchObject({ reason: 'schema_invalid', platform: 'meta', accountId: w.accountId, runId: out.runId });
    expect(q[0].issues[0].path).toBe('metrics.spend');
    expect(JSON.parse(q[0].payload).metrics.spend).toBeLessThan(0);
  });

  it('recovers after a crash: a new process resumes from the stored checkpoint without double counting', async () => {
    const w = await world();
    // Process 1 dies while storing the second page.
    const doomedStores = stores(w.clock);
    let calls = 0;
    const dying: MetricsStore = Object.create(doomedStores.metrics, {
      upsertObservations: {
        value: async (obs: MetricObservation[]) => {
          calls += 1;
          if (calls === 2) throw new Error('process killed');
          return doomedStores.metrics.upsertObservations(obs);
        },
      },
    });
    const crashed = await w.engine({ s: doomedStores, metrics: dying, maxAttempts: 1 }).syncAccount(w.connector, { accountId: w.accountId });
    expect(crashed.status).toBe('failed');
    const key = { workspaceId: w.workspaceId, source: 'meta', accountId: w.accountId, stream: 'hour' };
    expect(await w.s.checkpoints.get(key)).toBeNull();
    const partial = (await stored(w)).length;
    expect(partial).toBeGreaterThan(0);

    // Process 2 (new connections, new engine) completes the window.
    const p2 = stores(w.clock);
    const resumed = await w.engine({ s: p2 }).syncAccount(w.connector, { accountId: w.accountId });
    expect(resumed.status).toBe('completed');
    expect(resumed.unchanged).toBe(partial);
    const truth = await platformTruth(w, '2026-10-26T12:00:00.000Z', T0);
    expect((await stored(w)).length).toBe(truth.length);
    expectTotals(total(await stored(w)), total(truth));

    // Process 3 starts from the checkpoint process 2 wrote and pulls only what changed.
    const p3 = stores(w.clock);
    expect((await p3.checkpoints.get(key))?.cursor).toBe(resumed.cursor);
    const third = await w.engine({ s: p3 }).syncAccount(w.connector, { accountId: w.accountId });
    expect(third).toMatchObject({ status: 'completed', received: 0, ingested: 0, restated: 0 });
  });

  it('audit events travel over Redis Streams to the audit store, grouped under one traceId per run', async () => {
    const bus = new RedisStreamsEventBus({ url: config.eventBus.redisUrl });
    const auditStore = new ClickHouseAuditStore({ client: createClickHouseClient(chOptions), ownsClient: true });
    const topic = uniqueName('topic');
    const group = uniqueName('group');
    const consumer = new ConsumerHarness({ bus, store: auditStore, clock: new ManualClock(T0), ids: new RandomIdGenerator(), topic, group, selfAudit: false, overrides: { blockMs: 100 } });
    closers.push(async () => {
      await consumer.close();
      await bus.close();
      await auditStore.close();
    });
    const logger = new MemoryLogger();
    const emitter = createBusAuditEmitter({ bus, topic, service: 'metrics-ingester', defaultWorkspaceId: 'unused', clock: tickingClock(), ids: new RandomIdGenerator(), logger, failureMode: 'swallow' });
    const w = await world({ emitter });
    w.connector.injectFault({ kind: 'auth' }, 1);
    const failed = await w.engine().syncAccount(w.connector, { accountId: w.accountId });
    const ok = await w.engine().syncAccount(w.connector, { accountId: w.accountId });
    w.clock.advance(HOUR + 45 * 60_000);
    const later = await w.engine().syncAccount(w.connector, { accountId: w.accountId });
    await w.rollup().runOnce();

    for (let received = 1; received > 0; ) received = (await consumer.pump()).result.received;
    expect(logger.records.filter((r) => r.level === 'error')).toEqual([]);

    const trace = async (id: string) => (await auditStore.getTrace(id, { workspaceId: w.workspaceId })).map((e) => [e.action, e.outcome]);
    expect(await trace(failed.runId)).toEqual([['metrics.fetch_started', 'success'], ['metrics.fetch_failed', 'failure']]);
    expect(await trace(ok.runId)).toEqual([['metrics.fetch_started', 'success'], ['metrics.ingested', 'success'], ['metrics.fetch_completed', 'success']]);
    expect((await trace(later.runId)).map(([a]) => a)).toEqual(['metrics.fetch_started', 'metrics.ingested', 'metrics.restated', 'metrics.fetch_completed']);
    const completed = (await auditStore.getTrace(ok.runId, { workspaceId: w.workspaceId })).find((e) => e.action === 'metrics.fetch_completed')!;
    expect(completed.details).toMatchObject({ ingested: ok.ingested, pages: ok.pages, window: ok.window });
    expect(completed.durationMs).toBeGreaterThanOrEqual(0);
    expect(JSON.stringify(completed)).not.toMatch(/token|secret|password/i);
    expect(completed.target).toEqual({ type: 'ad_account', id: `meta:${w.accountId}` });
  });

  it('the analytics reader is audited and scoped on the real stores', async () => {
    const w = await world();
    await w.engine().syncAccount(w.connector, { accountId: w.accountId });
    await w.rollup().runOnce();
    const drafts: string[] = [];
    const reader = new AuditedAnalyticsReader(
      w.analytics,
      async () => w.scope,
      { emit: async (d) => (drafts.push(d.action), null), forTrace: function () { return this; } },
      w.clock
    );
    const ctx = { actor: { type: 'user' as const, id: 'u1' }, workspaceId: w.workspaceId };
    const day = { granularity: 'day' as const, from: '2026-10-27T00:00:00.000Z', to: '2026-10-29T00:00:00.000Z' };
    const s = await reader.getMetricsSummary(ctx, day);
    expect(s.totals[0].impressions).toBeGreaterThan(0);
    const c = await reader.comparePeriods(ctx, { granularity: 'day', current: { from: day.from, to: day.to } });
    expect(c.comparison[0].impressions.current).toBeGreaterThan(0);
    expect(drafts).toEqual(['data_access.metrics_summary', 'data_access.metrics_compare']);
    // Another workspace's scope sees none of it.
    const other = await w.analytics.getMetricsSummary({ workspaceId: 'x', accounts: [{ platform: 'meta', accountId: uniqueName('nobody') }] }, day);
    expect(other.totals).toEqual([]);
  });
});

describe('production guard', () => {
  const env = { EVENT_BUS: 'memory', AUDIT_STORE: 'memory', METRICS_STORE: 'memory', CHECKPOINT_STORE: 'memory', QUARANTINE_STORE: 'memory', PLATFORM_CONNECTORS: 'meta:stub,google:stub' };

  it('refuses to start the stub in production unless ALLOW_STUB_CONNECTOR=true', async () => {
    const logger = new MemoryLogger();
    await expect(createConnectors(loadConfig({ ...env, NODE_ENV: 'production' }), { logger })).rejects.toBeInstanceOf(StubConnectorNotAllowedError);
    const allowed = await createConnectors(loadConfig({ ...env, NODE_ENV: 'production', ALLOW_STUB_CONNECTOR: 'true' }), { logger });
    expect([...allowed.keys()]).toEqual(['meta', 'google']);
    const dev = await createConnectors(loadConfig({ ...env, NODE_ENV: 'development' }), { logger });
    expect(dev.size).toBe(2);
  });
});
