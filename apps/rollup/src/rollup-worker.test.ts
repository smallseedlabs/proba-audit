import { describe, expect, it } from 'vitest';
import { MemoryLogger, type AuditDraft, type AuditEmitter, type AuditEvent, type MetricObservation, type MetricsStore } from '@smallseedlabs/proba-audit-core';
import { makeObservation } from '@smallseedlabs/proba-audit-core/testing';
import { InMemoryCheckpointStore, InMemoryMetricsStore, ManualClock, SequentialIdGenerator } from '@smallseedlabs/proba-audit-adapters';
import { RollupWorker } from './rollup-worker.js';

class Recorder implements AuditEmitter {
  drafts: (AuditDraft & { traceId?: string })[] = [];
  async emit(d: AuditDraft): Promise<AuditEvent | null> {
    this.drafts.push(d);
    return null;
  }
  forTrace(traceId: string): AuditEmitter {
    return { emit: (d) => this.emit({ ...d, traceId }), forTrace: (t) => this.forTrace(t) };
  }
}

function setup(store?: MetricsStore, opts: { maxWindowDays?: number } = {}) {
  const clock = new ManualClock('2026-10-28T12:00:00.000Z');
  const metricsStore = store ?? new InMemoryMetricsStore(clock);
  const checkpoints = new InMemoryCheckpointStore(clock);
  const emitter = new Recorder();
  const logger = new MemoryLogger();
  const worker = new RollupWorker({
    metricsStore,
    checkpoints,
    emitter,
    clock,
    ids: new SequentialIdGenerator(),
    logger,
    options: { workspaceId: 'ws_test', serviceName: 'rollup', intervalMs: 10, maxWindowDays: opts.maxWindowDays ?? 7 },
  });
  return { clock, metricsStore, checkpoints, emitter, logger, worker };
}

const hourObs = (accountId: string, hourIso: string, n: number, extra: Partial<MetricObservation> = {}): MetricObservation => {
  const start = new Date(hourIso);
  return makeObservation({
    accountId,
    campaignId: 'cmp_1',
    adId: `ad_${n % 2}`,
    adsetId: 'set_1',
    periodStart: start.toISOString(),
    periodEnd: new Date(start.getTime() + 3_600_000).toISOString(),
    metrics: { impressions: 1000, clicks: 100, spend: 10, conversions: 1, reach: 800 },
    ...extra,
  });
};

const WS = 'ws_test';

const dayTotals = async (store: MetricsStore, accountId: string, from: string, to: string) =>
  store.aggregateRollups({ workspaceId: WS, bucket: 'day', from, to, groupBy: ['account', 'bucket'], accounts: [{ platform: 'meta', accountId }] });

describe('RollupWorker', () => {
  it('is idle when nothing changed and rolls up once when something did', async () => {
    const { worker, metricsStore, emitter } = setup();
    expect(await worker.runOnce()).toEqual({ status: 'idle' });
    expect(emitter.drafts).toHaveLength(0);

    await metricsStore.upsertObservations(WS, [hourObs('a', '2026-10-28T08:00:00.000Z', 1), hourObs('a', '2026-10-28T09:00:00.000Z', 2)]);
    const run = await worker.runOnce();
    expect(run).toMatchObject({ status: 'completed', observationCount: 2, chunks: 1 });
    expect(run.hourRows).toBe(2);
    expect(run.dayRows).toBe(2);
    expect(emitter.drafts).toHaveLength(1);
    expect(emitter.drafts[0]).toMatchObject({ action: 'metrics.rollup_run', category: 'metrics', outcome: 'success', workspaceId: 'ws_test', traceId: run.runId });
    expect(emitter.drafts[0].details).toMatchObject({ observationCount: 2, rows: { hour: 2, day: 2 } });

    expect(await worker.runOnce()).toEqual({ status: 'idle' }); // watermark moved
  });

  it('sums are right after a restatement: the new revision replaces the old one', async () => {
    const { worker, metricsStore } = setup();
    const hours = ['2026-10-28T08:00:00.000Z', '2026-10-28T09:00:00.000Z', '2026-10-28T10:00:00.000Z'];
    await metricsStore.upsertObservations(WS, hours.map((h, i) => hourObs('a', h, i)));
    await worker.runOnce();
    const day = () => dayTotals(metricsStore, 'a', '2026-10-28T00:00:00.000Z', '2026-10-29T00:00:00.000Z');
    expect((await day())[0].metrics).toMatchObject({ impressions: 3000, clicks: 300, spend: 30, conversions: 3 });

    // The platform restates hour 09:00: late conversions and a spend correction.
    await metricsStore.upsertObservations(WS, [
      hourObs('a', hours[1], 1, { revision: 1, metrics: { impressions: 1000, clicks: 100, spend: 12, conversions: 4, reach: 800 } }),
    ]);
    const run = await worker.runOnce();
    expect(run.status).toBe('completed');
    expect(run.observationCount).toBe(1);
    const [d] = await day();
    expect(d.metrics).toMatchObject({ impressions: 3000, clicks: 300, spend: 32, conversions: 6 }); // not 30+12 or 3+4
    const hourly = await metricsStore.aggregateRollups({ workspaceId: WS, bucket: 'hour', from: hours[0], to: '2026-10-28T11:00:00.000Z', groupBy: ['bucket'], accounts: [{ platform: 'meta', accountId: 'a' }] });
    expect(hourly.map((h) => [h.bucket, h.metrics.spend, h.metrics.conversions])).toEqual([
      [hours[0], 10, 1],
      [hours[1], 12, 4],
      [hours[2], 10, 1],
    ]);

    // Running again changes nothing.
    expect(await worker.runOnce()).toEqual({ status: 'idle' });
    expect((await day())[0].metrics.spend).toBe(32);
  });

  it('cuts days in the account timezone and never sums reach', async () => {
    const { worker, metricsStore } = setup();
    // Asia/Kolkata is UTC+5:30: local 2026-10-28 runs from 2026-10-27T18:30Z to 2026-10-28T18:30Z.
    const obs: MetricObservation[] = [];
    for (let h = 0; h < 24; h += 1) {
      const start = Date.parse('2026-10-27T18:30:00.000Z') + h * 3_600_000;
      obs.push(hourObs('kol', new Date(start).toISOString(), h, { timezone: 'Asia/Kolkata', adId: 'ad_1' }));
    }
    // One hour that belongs to the NEXT local day.
    obs.push(hourObs('kol', '2026-10-28T18:30:00.000Z', 0, { timezone: 'Asia/Kolkata', adId: 'ad_1' }));
    await metricsStore.upsertObservations(WS, obs);
    await worker.runOnce();
    const days = await dayTotals(metricsStore, 'kol', '2026-10-28T00:00:00.000Z', '2026-10-31T00:00:00.000Z');
    expect(days.map((d) => [d.bucket, d.metrics.impressions])).toEqual([
      ['2026-10-28', 24_000],
      ['2026-10-29', 1_000],
    ]);
    for (const d of days) expect('reach' in d.metrics).toBe(false);
    const rows = await metricsStore.queryRollups({ workspaceId: WS, bucket: 'day', accountId: 'kol' });
    expect(rows.every((r) => r.timezone === 'Asia/Kolkata' && r.bucketDate !== undefined && !('reach' in r.metrics))).toBe(true);
  });

  it('defaults to UTC days when the observation carries no timezone', async () => {
    const { worker, metricsStore } = setup();
    await metricsStore.upsertObservations(WS, [hourObs('u', '2026-10-27T23:00:00.000Z', 0), hourObs('u', '2026-10-28T00:00:00.000Z', 1)]);
    await worker.runOnce();
    const days = await dayTotals(metricsStore, 'u', '2026-10-27T00:00:00.000Z', '2026-10-30T00:00:00.000Z');
    expect(days.map((d) => d.bucket)).toEqual(['2026-10-27', '2026-10-28']);
  });

  it('splits a large changed window into chunks of maxWindowDays', async () => {
    const { worker, metricsStore } = setup(undefined, { maxWindowDays: 2 });
    const obs = [0, 1, 2, 3, 4, 5].map((d) => hourObs('c', new Date(Date.parse('2026-10-20T10:00:00.000Z') + d * 86_400_000).toISOString(), d));
    await metricsStore.upsertObservations(WS, obs);
    const run = await worker.runOnce();
    expect(run.chunks).toBeGreaterThanOrEqual(3);
    const days = await dayTotals(metricsStore, 'c', '2026-10-20T00:00:00.000Z', '2026-10-27T00:00:00.000Z');
    expect(days).toHaveLength(6);
    expect(days.every((d) => d.metrics.impressions === 1000)).toBe(true);
  });

  it('a failed run leaves the watermark alone and audits the failure; the next run catches up', async () => {
    const clock = new ManualClock('2026-10-28T12:00:00.000Z');
    const real = new InMemoryMetricsStore(clock);
    let fail = true;
    const flaky: MetricsStore = Object.create(real, {
      computeRollups: {
        value: async (r: Parameters<MetricsStore['computeRollups']>[0]) => {
          if (fail) throw new Error('clickhouse unavailable');
          return real.computeRollups(r);
        },
      },
    });
    const { worker, metricsStore, emitter } = setup(flaky);
    await metricsStore.upsertObservations(WS, [hourObs('f', '2026-10-28T08:00:00.000Z', 0)]);
    const failed = await worker.runOnce();
    expect(failed).toMatchObject({ status: 'failed', error: 'clickhouse unavailable' });
    expect(emitter.drafts.at(-1)).toMatchObject({ action: 'metrics.rollup_run', outcome: 'failure', errorCode: 'rollup_failed' });
    fail = false;
    expect(await worker.runOnce()).toMatchObject({ status: 'completed', observationCount: 1 });
  });

  it('a restarted worker continues from the stored watermark', async () => {
    const a = setup();
    await a.metricsStore.upsertObservations(WS, [hourObs('r', '2026-10-28T08:00:00.000Z', 0)]);
    await a.worker.runOnce();
    const b = new RollupWorker({
      metricsStore: a.metricsStore,
      checkpoints: a.checkpoints,
      clock: a.clock,
      ids: new SequentialIdGenerator(),
      logger: new MemoryLogger(),
      options: { workspaceId: 'ws_test', serviceName: 'rollup', intervalMs: 10, maxWindowDays: 7 },
    });
    expect(await b.runOnce()).toEqual({ status: 'idle' });
  });

  it('runs on its interval until stopped', async () => {
    const { worker, metricsStore, emitter } = setup();
    worker.start();
    await metricsStore.upsertObservations(WS, [hourObs('s', '2026-10-28T08:00:00.000Z', 0)]);
    const end = Date.now() + 3000;
    while (emitter.drafts.length === 0 && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
    await worker.stop();
    expect(emitter.drafts[0]?.action).toBe('metrics.rollup_run');
  });
});
