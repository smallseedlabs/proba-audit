import { describe, expect, it } from 'vitest';
import type { MetricObservation, MetricsStore } from '@smallseedlabs/proba-audit-core';
import { HOUR, makeHarness, type Harness } from './harness.testing.js';
import { redactSecrets } from './retry.js';

const ACCOUNT = { accountId: 'stub_meta_acct_1' };
const key = { workspaceId: 'ws_test', source: 'meta', accountId: ACCOUNT.accountId, stream: 'hour' };

const stored = (h: Harness) => h.metricsStore.queryObservations({ platform: 'meta', accountId: ACCOUNT.accountId, granularity: 'hour', limit: 10_000 });
const sum = (rows: MetricObservation[], f: (o: MetricObservation) => number) => rows.reduce((a, o) => a + f(o), 0);

describe('SyncEngine: first run', () => {
  it('backfills the initial lookback, stores a checkpoint and audits the run under one traceId', async () => {
    const h = makeHarness();
    const out = await h.engine.syncAccount(h.connector, ACCOUNT);

    expect(out).toMatchObject({ status: 'completed', quarantined: 0, restated: 0, unchanged: 0, platform: 'meta' });
    expect(out.ingested).toBeGreaterThan(0);
    expect(out.ingested).toBe(out.received);
    expect(out.pages).toBeGreaterThan(1); // pageSize 100 forces paging
    const rows = await stored(h);
    expect(rows).toHaveLength(out.ingested);
    expect(rows.every((o) => o.sourceRef?.startsWith('stub:'))).toBe(true);
    expect((await h.checkpoints.get(key))?.cursor).toBe(out.cursor);
    expect((await h.checkpoints.get(key))?.runId).toBe(out.runId);

    expect(h.emitter.actions()).toEqual(['metrics.fetch_started', 'metrics.ingested', 'metrics.fetch_completed']);
    expect(new Set(h.emitter.drafts.map((d) => d.traceId))).toEqual(new Set([out.runId]));
    const completed = h.emitter.drafts[2];
    expect(completed).toMatchObject({ category: 'metrics', outcome: 'success', workspaceId: 'ws_test', target: { type: 'ad_account', id: 'meta:stub_meta_acct_1' } });
    expect(completed.details).toMatchObject({ ingested: out.ingested, restated: 0, quarantined: 0, pages: out.pages, window: out.window });
    expect(completed.durationMs).toBeGreaterThanOrEqual(0);
    // Structured logs carry the same traceId.
    const logs = h.logger.records.filter((r) => r.fields.traceId === out.runId);
    expect(logs.map((r) => r.fields.lifecycle)).toEqual(['sync_started', 'sync_completed']);
  });

  it('never writes secrets into audit details or logs', async () => {
    const h = makeHarness();
    await h.engine.syncAccount(h.connector, { ...ACCOUNT, credentialsRef: 'vault://meta/secret-ref' });
    const text = JSON.stringify([h.emitter.drafts, h.logger.records]);
    expect(text).not.toContain('vault://');
    expect(text).not.toContain('credentialsRef');
  });
});

describe('SyncEngine: incremental pulls', () => {
  it('a second run right away stores nothing new and changes nothing', async () => {
    const h = makeHarness();
    const first = await h.engine.syncAccount(h.connector, ACCOUNT);
    const before = await stored(h);
    const second = await h.engine.syncAccount(h.connector, ACCOUNT);
    expect(second).toMatchObject({ status: 'completed', ingested: 0, restated: 0, quarantined: 0 });
    expect(second.received).toBeLessThan(first.received); // cursor: only what changed
    expect(await stored(h)).toEqual(before);
    expect(h.emitter.actions().filter((a) => a === 'metrics.ingested')).toHaveLength(1);
  });

  it('picks up only the new hour after an hour passes, and restated hours with a higher revision', async () => {
    const h = makeHarness({ stub: { restateEveryMinutes: 30, restateRevisions: 1 } });
    await h.engine.syncAccount(h.connector, ACCOUNT);
    const before = await stored(h);
    h.clock.advance(HOUR + 10 * 60_000); // 13:10
    const out = await h.engine.syncAccount(h.connector, ACCOUNT);
    const adsPerHour = new Set(before.map((o) => o.adId)).size;
    expect(out.ingested).toBe(adsPerHour); // hour 12-13
    expect(out.restated).toBeGreaterThan(0);
    expect(h.emitter.actions().slice(-4)).toEqual(['metrics.fetch_started', 'metrics.ingested', 'metrics.restated', 'metrics.fetch_completed']);

    const after = await stored(h);
    expect(after).toHaveLength(before.length + adsPerHour);
    const restated = after.filter((o) => before.some((b) => b.periodStart === o.periodStart && b.adId === o.adId && b.revision < o.revision));
    expect(restated.length).toBe(out.restated);
    // Restated values are the connector's own, not summed with the earlier revision.
    for (const o of restated) {
      const old = before.find((b) => b.periodStart === o.periodStart && b.adId === o.adId)!;
      expect(o.revision).toBe(old.revision + 1);
    }
    const restatedEvent = h.emitter.drafts.find((d) => d.action === 'metrics.restated')!;
    expect(restatedEvent.details).toMatchObject({ count: out.restated });
    expect(restatedEvent.details.earliestPeriodStart).toBeTruthy();
  });

  it('after downtime the window reaches back to the last success, not only the restatement window', async () => {
    const h = makeHarness({ stub: { restateRevisions: 0 } });
    await h.engine.syncAccount(h.connector, ACCOUNT);
    h.clock.advance(10 * HOUR); // ingester was down
    const out = await h.engine.syncAccount(h.connector, ACCOUNT);
    const adsPerHour = new Set((await stored(h)).map((o) => o.adId)).size;
    expect(out.ingested).toBe(10 * adsPerHour);
    expect(new Set((await stored(h)).map((o) => o.periodStart)).size).toBe(24 + 10);
  });
});

describe('SyncEngine: idempotency', () => {
  it('pulling the same window twice (checkpoint lost) double counts nothing', async () => {
    const h = makeHarness();
    await h.engine.syncAccount(h.connector, ACCOUNT);
    const before = await stored(h);
    await h.checkpoints.delete(key);
    const again = await h.engine.syncAccount(h.connector, ACCOUNT);
    expect(again).toMatchObject({ ingested: 0, restated: 0, staleSkipped: 0 });
    expect(again.unchanged).toBe(before.length);
    const after = await stored(h);
    expect(after).toEqual(before);
    expect(sum(after, (o) => o.metrics.spend)).toBeCloseTo(sum(before, (o) => o.metrics.spend), 9);
    expect(h.emitter.actions().filter((a) => a === 'metrics.ingested')).toHaveLength(1);
  });

  it('a stale revision never replaces a newer one', async () => {
    const h = makeHarness({ stub: { restateEveryMinutes: 30, restateRevisions: 2 } });
    h.clock.advance(HOUR); // 13:00
    await h.engine.syncAccount(h.connector, ACCOUNT);
    h.clock.advance(2 * HOUR);
    await h.engine.syncAccount(h.connector, ACCOUNT); // restated to the final revision
    const before = await stored(h);
    // A replica of the connector as it was earlier (clock behind) now answers with older revisions.
    const earlier = makeHarness({ now: '2026-10-28T13:00:00.000Z', stub: { restateEveryMinutes: 30, restateRevisions: 2 } });
    await h.checkpoints.delete(key);
    const out = await h.engine.syncAccount(earlier.connector, ACCOUNT);
    expect(out.status).toBe('completed');
    expect(out.staleSkipped).toBeGreaterThan(0);
    expect(await stored(h)).toEqual(before);
  });
});

describe('SyncEngine: failures', () => {
  it('retries transient errors with exponential backoff and then succeeds', async () => {
    const h = makeHarness();
    h.connector.injectFault({ kind: 'transient' }, 2);
    const out = await h.engine.syncAccount(h.connector, ACCOUNT);
    expect(out.status).toBe('completed');
    expect(h.sleeps).toEqual([100, 200]); // base * 2^n, jitter pinned to 1
    expect(h.logger.records.filter((r) => r.fields.lifecycle === 'sync_retry')).toHaveLength(2);
  });

  it('gives up after maxAttempts, leaves the checkpoint alone and audits the failure', async () => {
    const h = makeHarness();
    await h.engine.syncAccount(h.connector, ACCOUNT);
    const checkpoint = await h.checkpoints.get(key);
    h.clock.advance(HOUR);
    h.connector.injectFault({ kind: 'transient' }, 3);
    const out = await h.engine.syncAccount(h.connector, ACCOUNT);
    expect(out).toMatchObject({ status: 'failed', error: { code: 'transient', attempts: 3 } });
    expect(await h.checkpoints.get(key)).toEqual(checkpoint);
    const failed = h.emitter.drafts.at(-1)!;
    expect(failed).toMatchObject({ action: 'metrics.fetch_failed', outcome: 'failure', errorCode: 'transient', category: 'metrics' });
    expect(failed.details).toMatchObject({ attempts: 3, ingested: 0 });
    // The next run recovers and ingests what was missed.
    const recovered = await h.engine.syncAccount(h.connector, ACCOUNT);
    expect(recovered.status).toBe('completed');
    expect(recovered.ingested).toBeGreaterThan(0);
  });

  it('waits for the platform rate-limit hint instead of its own backoff', async () => {
    const h = makeHarness();
    h.connector.injectFault({ kind: 'rate_limit', retryAfterMs: 4000 }, 1);
    const out = await h.engine.syncAccount(h.connector, ACCOUNT);
    expect(out.status).toBe('completed');
    expect(h.sleeps).toEqual([4000]);
  });

  it('ends the run, without sleeping, when the hint is longer than it will wait, and reports it to the scheduler', async () => {
    const h = makeHarness();
    h.connector.injectFault({ kind: 'rate_limit', retryAfterMs: 120_000 }, 1);
    const out = await h.engine.syncAccount(h.connector, ACCOUNT);
    expect(out).toMatchObject({ status: 'failed', retryAfterMs: 120_000, error: { code: 'rate_limited' } });
    expect(h.sleeps).toEqual([]);
    expect(h.emitter.drafts.at(-1)!.details).toMatchObject({ retryAfterMs: 120_000 });
  });

  it('does not retry credential or request errors', async () => {
    for (const kind of ['auth', 'request'] as const) {
      const h = makeHarness();
      h.connector.injectFault({ kind }, 5);
      const out = await h.engine.syncAccount(h.connector, ACCOUNT);
      expect(out).toMatchObject({ status: 'failed', error: { attempts: 1 } });
      expect(h.sleeps).toEqual([]);
    }
  });

  it('retries a failing store write and does not double count when it works again', async () => {
    const h = makeHarness();
    const real = h.metricsStore;
    let failures = 1;
    const flaky: MetricsStore = Object.create(real, {
      upsertObservations: {
        value: async (obs: MetricObservation[]) => {
          if (failures-- > 0) throw new Error('clickhouse unavailable');
          return real.upsertObservations(obs);
        },
      },
    });
    const h2 = makeHarness({ metricsStore: flaky });
    const out = await h2.engine.syncAccount(h2.connector, ACCOUNT);
    expect(out.status).toBe('completed');
    const clean = makeHarness();
    await clean.engine.syncAccount(clean.connector, ACCOUNT);
    expect(await stored(h2)).toEqual(await stored(clean));
  });

  it('redacts credentials that appear in error messages', () => {
    expect(redactSecrets('request failed: Bearer abc.def.ghi and api_key=sk-123, token: xyz')).not.toMatch(/abc\.def|sk-123|xyz/);
    expect(redactSecrets('x'.repeat(2000))).toHaveLength(500);
  });
});

describe('SyncEngine: crash recovery', () => {
  it('a run that dies half way leaves no checkpoint; the next run completes with the same data as an uninterrupted one', async () => {
    const h = makeHarness();
    const real = h.metricsStore;
    let calls = 0;
    const dying: MetricsStore = Object.create(real, {
      upsertObservations: {
        value: async (obs: MetricObservation[]) => {
          calls += 1;
          if (calls === 2) throw new Error('process killed');
          return real.upsertObservations(obs);
        },
      },
    });
    const crashing = makeHarness({ metricsStore: dying, checkpoints: h.checkpoints, engine: { retry: { maxAttempts: 1, baseMs: 1, maxMs: 1, maxRateLimitWaitMs: 1 } } });
    const failed = await crashing.engine.syncAccount(crashing.connector, ACCOUNT);
    expect(failed.status).toBe('failed');
    expect(await crashing.checkpoints.get(key)).toBeNull();
    const partial = await stored(crashing);
    expect(partial.length).toBeGreaterThan(0);

    const resumed = await crashing.engine.syncAccount(crashing.connector, ACCOUNT);
    expect(resumed.status).toBe('completed');
    expect(resumed.unchanged).toBe(partial.length); // first page was already durable
    const clean = makeHarness();
    await clean.engine.syncAccount(clean.connector, ACCOUNT);
    expect(await stored(crashing)).toEqual(await stored(clean));
    expect(await crashing.checkpoints.get(key)).not.toBeNull();
  });

  it('a stored checkpoint makes a restarted engine resume incrementally', async () => {
    const h = makeHarness();
    await h.engine.syncAccount(h.connector, ACCOUNT);
    // "Restart": new engine and connector over the same stores.
    const restarted = makeHarness({ metricsStore: h.metricsStore, checkpoints: h.checkpoints, quarantine: h.quarantine });
    const out = await restarted.engine.syncAccount(restarted.connector, ACCOUNT);
    expect(out).toMatchObject({ status: 'completed', ingested: 0, restated: 0 });
    expect(out.received).toBe(0);
  });
});

describe('SyncEngine: quarantine', () => {
  it('keeps invalid observations out of the metrics tables, with the reason, and stores the rest', async () => {
    const h = makeHarness();
    h.connector.corruptNext('negative_spend', 2);
    const out = await h.engine.syncAccount(h.connector, ACCOUNT);
    expect(out).toMatchObject({ status: 'completed', quarantined: 2 });
    expect(out.ingested).toBe(out.received - 2);
    const rows = await stored(h);
    expect(rows.every((o) => o.metrics.spend >= 0)).toBe(true);
    const q = await h.quarantine.list({ workspaceId: 'ws_test' });
    expect(q).toHaveLength(2);
    expect(q[0]).toMatchObject({ reason: 'schema_invalid', platform: 'meta', accountId: ACCOUNT.accountId, runId: out.runId });
    expect(q[0].issues[0].path).toBe('metrics.spend');
    expect(JSON.parse(q[0].payload).metrics.spend).toBeLessThan(0);
    expect(h.emitter.drafts.find((d) => d.action === 'metrics.fetch_completed')!.details).toMatchObject({ quarantined: 2 });
    expect(h.logger.records.some((r) => r.fields.lifecycle === 'sync_quarantined')).toBe(true);
  });

  it('quarantines observations of another platform, and malformed periods and currencies', async () => {
    for (const [how, reason] of [['wrong_platform', 'platform_mismatch'], ['bad_period', 'schema_invalid'], ['missing_currency', 'schema_invalid']] as const) {
      const h = makeHarness();
      h.connector.corruptNext(how, 1);
      const out = await h.engine.syncAccount(h.connector, ACCOUNT);
      expect(out.quarantined).toBe(1);
      expect((await h.quarantine.list())[0].reason).toBe(reason);
    }
  });
});

describe('SyncEngine: windows', () => {
  it('fails clearly when the connector does not offer the configured granularity', async () => {
    const h = makeHarness();
    const noDay = Object.create(h.connector, {
      capabilities: { value: () => ({ ...h.connector.capabilities(), granularities: ['hour'] }) },
    });
    const h2 = makeHarness({ engine: { granularity: 'day' } });
    const out = await h2.engine.syncAccount(noDay, ACCOUNT);
    expect(out).toMatchObject({ status: 'failed', error: { code: 'invalid_request' } });
  });

  it('daily granularity ingests complete local days', async () => {
    const h = makeHarness({ engine: { granularity: 'day', initialLookbackHours: 24 * 4 } });
    const out = await h.engine.syncAccount(h.connector, ACCOUNT);
    expect(out.status).toBe('completed');
    const rows = await h.metricsStore.queryObservations({ platform: 'meta', accountId: ACCOUNT.accountId, granularity: 'day', limit: 10_000 });
    expect(rows.length).toBeGreaterThan(0);
    expect(new Set(rows.map((o) => o.periodStart)).size).toBeGreaterThanOrEqual(3);
  });
});

