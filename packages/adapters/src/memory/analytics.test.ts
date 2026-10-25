import { describe, expect, it } from 'vitest';
import {
  ANALYTICS_LIMITS,
  AnalyticsValidationError,
  AuditedAnalyticsReader,
  MetricsAnalytics,
  type AnalyticsScope,
  type AuditDraft,
  type AuditEmitter,
  type AuditEvent,
  type MetricObservation,
} from '@smallseedlabs/proba-audit-core';
import { makeObservation } from '@smallseedlabs/proba-audit-core/testing';
import { ManualClock } from './clock-ids.js';
import { InMemoryMetricsStore } from './metrics-store.js';

const scope = (accountIds: string[], workspaceId = 'ws_1'): AnalyticsScope => ({
  workspaceId,
  accounts: accountIds.map((accountId) => ({ platform: 'meta' as const, accountId })),
});

const hour = (iso: string, extra: Partial<MetricObservation> = {}): MetricObservation => {
  const s = new Date(iso);
  return makeObservation({
    periodStart: s.toISOString(),
    periodEnd: new Date(s.getTime() + 3_600_000).toISOString(),
    metrics: { impressions: 1000, clicks: 50, spend: 10, conversions: 2, reach: 900, revenue: 40 },
    ...extra,
  });
};

async function seeded() {
  const store = new InMemoryMetricsStore();
  await store.upsertObservations([
    hour('2026-10-26T10:00:00.000Z', { accountId: 'a1', campaignId: 'c1' }),
    hour('2026-10-26T11:00:00.000Z', { accountId: 'a1', campaignId: 'c1' }),
    hour('2026-10-26T11:00:00.000Z', { accountId: 'a1', campaignId: 'c2', metrics: { impressions: 500, clicks: 5, spend: 25, conversions: 0 } }),
    hour('2026-10-26T11:00:00.000Z', { accountId: 'a1', campaignId: 'c3', currency: 'EUR' }),
    hour('2026-10-19T10:00:00.000Z', { accountId: 'a1', campaignId: 'c1', metrics: { impressions: 800, clicks: 40, spend: 8, conversions: 1 } }),
    hour('2026-10-26T10:00:00.000Z', { accountId: 'other', campaignId: 'secret', metrics: { impressions: 9_999_999, clicks: 1, spend: 1, conversions: 1 } }),
  ]);
  await store.computeRollups({ bucket: 'hour', from: '2026-10-19T00:00:00.000Z', to: '2026-10-27T00:00:00.000Z' });
  await store.computeRollups({ bucket: 'day', from: '2026-10-19T00:00:00.000Z', to: '2026-10-27T00:00:00.000Z' });
  return { store, analytics: new MetricsAnalytics(store) };
}

const day = { granularity: 'day' as const, from: '2026-10-26T00:00:00.000Z', to: '2026-10-27T00:00:00.000Z' };

describe('getMetricsSummary', () => {
  it('returns totals per currency, a series and campaigns, with derived ratios and no reach', async () => {
    const { analytics } = await seeded();
    const s = await analytics.getMetricsSummary(scope(['a1']), day);
    expect(s.totals.map((t) => t.currency)).toEqual(['EUR', 'USD']);
    const usd = s.totals.find((t) => t.currency === 'USD')!;
    expect(usd).toMatchObject({ impressions: 2500, clicks: 105, spend: 45, conversions: 4, revenue: 80, observationCount: 3 });
    expect(usd.ctr).toBeCloseTo(105 / 2500, 6);
    expect(usd.cpc).toBeCloseTo(45 / 105, 6);
    expect(usd.cpm).toBeCloseTo(18, 6);
    expect(usd.cpa).toBeCloseTo(11.25, 6);
    expect(usd.roas).toBeCloseTo(80 / 45, 6);
    expect(JSON.stringify(s)).not.toContain('reach');
    expect(s.series.map((p) => [p.bucket, p.currency, p.impressions])).toEqual([
      ['2026-10-26', 'EUR', 1000],
      ['2026-10-26', 'USD', 2500],
    ]);
    expect(s.campaigns?.map((c) => [c.campaignId, c.currency, c.spend])).toEqual([
      ['c2', 'USD', 25],
      ['c1', 'USD', 20],
      ['c3', 'EUR', 10],
    ]);
    expect(s.campaignsTruncated).toBe(false);
  });

  it('hourly series with a campaign filter, and a null ratio when the divisor is zero', async () => {
    const { analytics } = await seeded();
    const s = await analytics.getMetricsSummary(scope(['a1']), { granularity: 'hour', from: '2026-10-26T00:00:00.000Z', to: '2026-10-27T00:00:00.000Z', campaignId: 'c2' });
    expect(s.campaigns).toBeUndefined();
    expect(s.series.map((p) => [p.bucket, p.spend])).toEqual([['2026-10-26T11:00:00.000Z', 25]]);
    expect(s.totals[0].cpa).toBeNull(); // no conversions
    expect(s.totals[0].roas).toBeNull(); // no revenue reported
  });

  it('only sees the accounts in the scope', async () => {
    const { analytics } = await seeded();
    const own = await analytics.getMetricsSummary(scope(['a1']), day);
    expect(JSON.stringify(own)).not.toContain('secret');
    const none = await analytics.getMetricsSummary(scope([]), day);
    expect(none.totals).toEqual([]);
    expect(none.series).toEqual([]);
    const other = await analytics.getMetricsSummary(scope(['other']), day);
    expect(other.totals[0].impressions).toBe(9_999_999);
  });

  it('reflects a restatement (latest revision, not a sum of revisions)', async () => {
    const { store, analytics } = await seeded();
    await store.upsertObservations([hour('2026-10-26T10:00:00.000Z', { accountId: 'a1', campaignId: 'c1', revision: 1, metrics: { impressions: 1000, clicks: 50, spend: 14, conversions: 5 } })]);
    await store.computeRollups({ bucket: 'hour', from: '2026-10-26T00:00:00.000Z', to: '2026-10-27T00:00:00.000Z' });
    await store.computeRollups({ bucket: 'day', from: '2026-10-26T00:00:00.000Z', to: '2026-10-27T00:00:00.000Z' });
    const s = await analytics.getMetricsSummary(scope(['a1']), { ...day, campaignId: 'c1' });
    expect(s.totals[0]).toMatchObject({ spend: 24, conversions: 7 }); // 14 + 10, 5 + 2
  });

  it('keeps daily buckets in the account timezone', async () => {
    const store = new InMemoryMetricsStore();
    // 20:00Z on the 26th is already the 27th in Sydney (UTC+11 in late October).
    await store.upsertObservations([hour('2026-10-26T20:00:00.000Z', { accountId: 'syd', timezone: 'Australia/Sydney' })]);
    await store.computeRollups({ bucket: 'day', from: '2026-10-26T00:00:00.000Z', to: '2026-10-28T00:00:00.000Z' });
    const s = await new MetricsAnalytics(store).getMetricsSummary(scope(['syd']), { granularity: 'day', from: '2026-10-26T00:00:00.000Z', to: '2026-10-28T00:00:00.000Z' });
    expect(s.series.map((p) => p.bucket)).toEqual(['2026-10-27']);
  });

  it('reads only the configured source granularity', async () => {
    const store = new InMemoryMetricsStore();
    await store.upsertObservations([
      hour('2026-10-26T10:00:00.000Z', { accountId: 'a', campaignId: 'c' }),
      makeObservation({ accountId: 'a', campaignId: 'c', granularity: 'day', periodStart: '2026-10-26T00:00:00.000Z', periodEnd: '2026-10-27T00:00:00.000Z', metrics: { impressions: 777, clicks: 7, spend: 7, conversions: 7 } }),
    ]);
    await store.computeRollups({ bucket: 'day', from: '2026-10-26T00:00:00.000Z', to: '2026-10-27T00:00:00.000Z' });
    const hourly = await new MetricsAnalytics(store).getMetricsSummary(scope(['a']), day);
    const daily = await new MetricsAnalytics(store, { sourceGranularity: 'day' }).getMetricsSummary(scope(['a']), day);
    expect(hourly.totals[0].impressions).toBe(1000);
    expect(daily.totals[0].impressions).toBe(777);
  });
});

describe('strict argument validation', () => {
  const reject = async (query: unknown, match?: RegExp) => {
    const { analytics } = await seeded();
    const err = await analytics.getMetricsSummary(scope(['a1']), query as never).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AnalyticsValidationError);
    if (match) expect((err as Error).message).toMatch(match);
  };

  it('rejects unknown keys, so a caller cannot smuggle in accounts or a workspace', async () => {
    await reject({ ...day, accounts: [{ platform: 'meta', accountId: 'other' }] });
    await reject({ ...day, workspaceId: 'ws_2' });
  });

  it('rejects missing, malformed and unordered dates', async () => {
    await reject({ granularity: 'day' });
    await reject({ ...day, from: '2026-10-26' }, /ISO 8601/);
    await reject({ ...day, from: '2026-10-26T00:00:00+01:00' });
    await reject({ ...day, from: day.to, to: day.from }, /after from/);
    await reject({ ...day, to: day.from }, /after from/);
  });

  it('rejects ranges not aligned to the bucket', async () => {
    await reject({ granularity: 'hour', from: '2026-10-26T10:30:00.000Z', to: '2026-10-26T12:00:00.000Z' }, /on the hour/);
    await reject({ granularity: 'day', from: '2026-10-26T10:00:00.000Z', to: '2026-10-28T00:00:00.000Z' }, /UTC midnight/);
  });

  it('caps the range per granularity', async () => {
    const h = ANALYTICS_LIMITS.maxRangeDays.hour;
    await reject({ granularity: 'hour', from: '2026-01-01T00:00:00.000Z', to: new Date(Date.parse('2026-01-01T00:00:00.000Z') + (h + 1) * 86_400_000).toISOString() }, /longer than 14 days/);
    const { analytics } = await seeded();
    await expect(
      analytics.getMetricsSummary(scope(['a1']), { granularity: 'hour', from: '2026-10-12T00:00:00.000Z', to: '2026-10-26T00:00:00.000Z' })
    ).resolves.toBeTruthy(); // exactly 14 days is allowed
    const d = ANALYTICS_LIMITS.maxRangeDays.day;
    await reject({ granularity: 'day', from: '2025-01-01T00:00:00.000Z', to: new Date(Date.parse('2025-01-01T00:00:00.000Z') + (d + 1) * 86_400_000).toISOString() }, /longer than 366 days/);
  });

  it('rejects odd campaign ids and granularities', async () => {
    await reject({ ...day, campaignId: "c1' OR 1=1 --" });
    await reject({ ...day, campaignId: 'x'.repeat(ANALYTICS_LIMITS.maxCampaignIdLength + 1) });
    await reject({ ...day, campaignId: '' });
    await reject({ ...day, granularity: 'week' });
  });

  it('rejects a scope that is too large', async () => {
    const { analytics } = await seeded();
    const big = scope(Array.from({ length: ANALYTICS_LIMITS.maxAccountsInScope + 1 }, (_, i) => `a${i}`));
    await expect(analytics.getMetricsSummary(big, day)).rejects.toBeInstanceOf(AnalyticsValidationError);
  });
});

describe('comparePeriods', () => {
  it('compares with the period right before when previous is omitted', async () => {
    const { analytics } = await seeded();
    const r = await analytics.comparePeriods(scope(['a1']), {
      granularity: 'day',
      campaignId: 'c1',
      current: { from: '2026-10-26T00:00:00.000Z', to: '2026-10-27T00:00:00.000Z' },
    });
    expect(r.previous).toMatchObject({ from: '2026-10-25T00:00:00.000Z', to: '2026-10-26T00:00:00.000Z' });
    expect(r.comparison).toEqual([
      {
        currency: 'USD',
        impressions: { current: 2000, previous: 0, change: 2000, changePct: null },
        clicks: { current: 100, previous: 0, change: 100, changePct: null },
        spend: { current: 20, previous: 0, change: 20, changePct: null },
        conversions: { current: 4, previous: 0, change: 4, changePct: null },
      },
    ]);
  });

  it('computes absolute and percentage change against an explicit previous period', async () => {
    const { analytics } = await seeded();
    const r = await analytics.comparePeriods(scope(['a1']), {
      granularity: 'day',
      campaignId: 'c1',
      current: { from: '2026-10-26T00:00:00.000Z', to: '2026-10-27T00:00:00.000Z' },
      previous: { from: '2026-10-19T00:00:00.000Z', to: '2026-10-20T00:00:00.000Z' },
    });
    const usd = r.comparison.find((c) => c.currency === 'USD')!;
    expect(usd.spend).toEqual({ current: 20, previous: 8, change: 12, changePct: 150 });
    expect(usd.impressions).toEqual({ current: 2000, previous: 800, change: 1200, changePct: 150 });
  });

  it('rejects a previous period of another length and extra keys', async () => {
    const { analytics } = await seeded();
    const bad = (q: unknown) => analytics.comparePeriods(scope(['a1']), q as never);
    await expect(bad({ granularity: 'day', current: { from: '2026-10-26T00:00:00.000Z', to: '2026-10-27T00:00:00.000Z' }, previous: { from: '2026-10-19T00:00:00.000Z', to: '2026-10-21T00:00:00.000Z' } })).rejects.toThrow(/as long as current/);
    await expect(bad({ granularity: 'day', current: { from: '2026-10-26T00:00:00.000Z', to: '2026-10-27T00:00:00.000Z' }, scope: {} })).rejects.toBeInstanceOf(AnalyticsValidationError);
  });
});

describe('AuditedAnalyticsReader', () => {
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
  const ctx = { actor: { type: 'user' as const, id: 'u1' }, workspaceId: 'ws_1', userId: 'u1', traceId: 'trace-1' };

  async function reader(resolve = async (c: { workspaceId: string }) => scope(['a1'], c.workspaceId)) {
    const { analytics } = await seeded();
    const emitter = new Recorder();
    return { emitter, reader: new AuditedAnalyticsReader(analytics, resolve, emitter, new ManualClock()) };
  }

  it('resolves the scope itself and audits the read with names of filters, never values', async () => {
    const { reader: r, emitter } = await reader();
    const s = await r.getMetricsSummary(ctx, { ...day, campaignId: 'c1' });
    expect(s.totals[0].spend).toBe(20);
    expect(emitter.drafts).toHaveLength(1);
    expect(emitter.drafts[0]).toMatchObject({
      action: 'data_access.metrics_summary',
      category: 'data_access',
      outcome: 'success',
      workspaceId: 'ws_1',
      traceId: 'trace-1',
      target: { type: 'metrics', id: 'ws_1' },
    });
    expect(emitter.drafts[0].details).toMatchObject({ filters: ['campaignId', 'from', 'granularity', 'to'] });
    expect(JSON.stringify(emitter.drafts[0])).not.toContain('c1');
  });

  it('audits comparisons', async () => {
    const { reader: r, emitter } = await reader();
    await r.comparePeriods(ctx, { granularity: 'day', current: { from: day.from, to: day.to } });
    expect(emitter.drafts[0]).toMatchObject({ action: 'data_access.metrics_compare', outcome: 'success' });
  });

  it('audits rejected queries and rethrows', async () => {
    const { reader: r, emitter } = await reader();
    await expect(r.getMetricsSummary(ctx, { ...day, from: 'nope' })).rejects.toBeInstanceOf(AnalyticsValidationError);
    expect(emitter.drafts[0]).toMatchObject({ outcome: 'failure', errorCode: 'invalid_query' });
  });

  it('refuses a scope that belongs to another workspace', async () => {
    const { reader: r, emitter } = await reader(async () => scope(['a1'], 'ws_other'));
    await expect(r.getMetricsSummary(ctx, day)).rejects.toThrow(/does not belong/);
    expect(emitter.drafts[0].outcome).toBe('failure');
  });
});
