import { afterEach, describe, expect, it } from 'vitest';
import type { MetricsStore } from '../ports/metrics-store.js';
import { makeObservation, uniqueName } from './fixtures.js';

export interface MetricsStoreHarness {
  store: MetricsStore;
  cleanup?: () => Promise<void>;
}

/**
 * Contract any MetricsStore adapter must satisfy. Each test uses its own
 * accountId so one shared database can run the whole suite.
 */
export function runMetricsStoreContract(name: string, factory: () => Promise<MetricsStoreHarness>): void {
  describe(`MetricsStore contract: ${name}`, () => {
    const harnesses: MetricsStoreHarness[] = [];
    async function create(): Promise<MetricsStore> {
      const h = await factory();
      harnesses.push(h);
      return h.store;
    }
    afterEach(async () => {
      while (harnesses.length) {
        const h = harnesses.pop()!;
        await h.store.close();
        await h.cleanup?.();
      }
    });

    const hour = (h: number, extra = {}) => ({
      periodStart: `2026-10-25T${String(h).padStart(2, '0')}:00:00.000Z`,
      periodEnd: `2026-10-25T${String(h + 1).padStart(2, '0')}:00:00.000Z`,
      ...extra,
    });

    it('pings', async () => {
      await expect((await create()).ping()).resolves.toBeUndefined();
    });

    it('upserts and reads back observations unchanged, ordered by periodStart', async () => {
      const store = await create();
      const accountId = uniqueName('act');
      const full = makeObservation({
        accountId,
        ...hour(11),
        adsetId: 'as_1',
        adId: 'ad_1',
        timezone: 'Europe/London',
        sourceRef: 'report-1',
        metrics: { impressions: 1000, clicks: 50, spend: 12.5, conversions: 2.5, reach: 800, videoViews: 100, revenue: 40.25 },
        revision: 1,
      });
      const minimal = makeObservation({ accountId, ...hour(10) });
      expect(await store.upsertObservations([full, minimal])).toEqual({ written: 2, skippedStale: 0 });
      const got = await store.queryObservations({ accountId });
      expect(got).toEqual([minimal, full]);
    });

    it('keeps the highest revision and skips stale ones', async () => {
      const store = await create();
      const accountId = uniqueName('act');
      const base = { accountId, ...hour(10) };
      await store.upsertObservations([makeObservation({ ...base, revision: 0, metrics: { impressions: 100, clicks: 1, spend: 1, conversions: 0 } })]);
      expect(
        await store.upsertObservations([makeObservation({ ...base, revision: 1, metrics: { impressions: 120, clicks: 2, spend: 1.5, conversions: 1 } })])
      ).toEqual({ written: 1, skippedStale: 0 });
      expect(
        await store.upsertObservations([makeObservation({ ...base, revision: 0, metrics: { impressions: 999, clicks: 9, spend: 9, conversions: 9 } })])
      ).toEqual({ written: 0, skippedStale: 1 });
      const got = await store.queryObservations({ accountId });
      expect(got).toHaveLength(1);
      expect(got[0].revision).toBe(1);
      expect(got[0].metrics.impressions).toBe(120);
    });

    it('accepts the same revision again (idempotent replace)', async () => {
      const store = await create();
      const accountId = uniqueName('act');
      const o = makeObservation({ accountId, revision: 2 });
      await store.upsertObservations([o]);
      expect(await store.upsertObservations([o])).toEqual({ written: 1, skippedStale: 0 });
      expect(await store.queryObservations({ accountId })).toEqual([o]);
    });

    it('lets the highest revision win when one batch repeats a key', async () => {
      const store = await create();
      const accountId = uniqueName('act');
      const lo = makeObservation({ accountId, revision: 0 });
      const hi = makeObservation({ accountId, revision: 3, metrics: { impressions: 5, clicks: 5, spend: 5, conversions: 5 } });
      await store.upsertObservations([hi, lo]);
      const got = await store.queryObservations({ accountId });
      expect(got).toHaveLength(1);
      expect(got[0].revision).toBe(3);
    });

    it('treats campaign, adset and ad level rows as different keys', async () => {
      const store = await create();
      const accountId = uniqueName('act');
      await store.upsertObservations([
        makeObservation({ accountId }),
        makeObservation({ accountId, adsetId: 'as_1' }),
        makeObservation({ accountId, adsetId: 'as_1', adId: 'ad_1' }),
      ]);
      expect(await store.queryObservations({ accountId })).toHaveLength(3);
      expect(await store.queryObservations({ accountId, adsetId: 'as_1', adId: 'ad_1' })).toHaveLength(1);
    });

    it('filters by platform, campaign, granularity and period', async () => {
      const store = await create();
      const accountId = uniqueName('act');
      await store.upsertObservations([
        makeObservation({ accountId, ...hour(10) }),
        makeObservation({ accountId, ...hour(11) }),
        makeObservation({ accountId, ...hour(12), campaignId: 'cmp_2' }),
        makeObservation({ accountId, platform: 'google' }),
        makeObservation({ accountId, granularity: 'day', periodStart: '2026-10-25T00:00:00.000Z', periodEnd: '2026-10-26T00:00:00.000Z' }),
      ]);
      expect(await store.queryObservations({ accountId, platform: 'google' })).toHaveLength(1);
      expect(await store.queryObservations({ accountId, campaignId: 'cmp_2' })).toHaveLength(1);
      expect(await store.queryObservations({ accountId, granularity: 'day' })).toHaveLength(1);
      const window = await store.queryObservations({ accountId, platform: 'meta', granularity: 'hour', campaignId: 'cmp_1', from: '2026-10-25T11:00:00.000Z', to: '2026-10-25T12:00:00.000Z' });
      expect(window.map((o) => o.periodStart)).toEqual(['2026-10-25T11:00:00.000Z']);
      expect(await store.queryObservations({ accountId, limit: 2 })).toHaveLength(2);
    });

    it('computes hourly and daily rollups from the latest revisions, idempotently', async () => {
      const store = await create();
      const accountId = uniqueName('act');
      await store.upsertObservations([
        makeObservation({ accountId, ...hour(10), metrics: { impressions: 100, clicks: 10, spend: 1, conversions: 1, videoViews: 5, revenue: 2 } }),
        makeObservation({ accountId, ...hour(10), revision: 1, metrics: { impressions: 200, clicks: 20, spend: 2, conversions: 2, videoViews: 10, revenue: 4 } }),
        makeObservation({ accountId, ...hour(11), metrics: { impressions: 50, clicks: 5, spend: 0.5, conversions: 0, reach: 40 } }),
        makeObservation({ accountId, ...hour(23), metrics: { impressions: 1, clicks: 1, spend: 0.25, conversions: 0 } }),
        makeObservation({ accountId, periodStart: '2026-10-26T00:00:00.000Z', periodEnd: '2026-10-26T01:00:00.000Z', metrics: { impressions: 7, clicks: 0, spend: 0, conversions: 0 } }),
      ]);
      const window = { from: '2026-10-25T10:30:00.000Z', to: '2026-10-26T00:30:00.000Z' };

      // Rollups cover every account in the store, so other data may add rows:
      // this account alone contributes 4 hourly buckets (10, 11, 23 and 00 next day,
      // because the window aligns outwards to 10:00 .. 01:00).
      const hourlyWritten = await store.computeRollups({ bucket: 'hour', ...window });
      expect(hourlyWritten).toBeGreaterThanOrEqual(4);
      expect(await store.computeRollups({ bucket: 'hour', ...window })).toBe(hourlyWritten); // idempotent

      const hourly = await store.queryRollups({ bucket: 'hour', accountId });
      expect(hourly).toHaveLength(4);
      expect(hourly[0]).toMatchObject({
        bucket: 'hour',
        sourceGranularity: 'hour',
        bucketStart: '2026-10-25T10:00:00.000Z',
        currency: 'USD',
        metrics: { impressions: 200, clicks: 20, spend: 2, conversions: 2, videoViews: 10, revenue: 4 },
        observationCount: 1,
      });
      expect(hourly[0].computedAt).toMatch(/Z$/);
      expect(hourly[1].metrics).toMatchObject({ impressions: 50, clicks: 5 });
      expect(hourly[1].metrics.videoViews).toBeUndefined();
      expect('reach' in hourly[1].metrics).toBe(false);

      await store.computeRollups({ bucket: 'day', ...window });
      const daily = await store.queryRollups({ bucket: 'day', accountId });
      expect(daily).toHaveLength(2);
      expect(daily[0]).toMatchObject({
        bucketStart: '2026-10-25T00:00:00.000Z',
        sourceGranularity: 'hour',
        observationCount: 3,
        metrics: { impressions: 251, clicks: 26, spend: 2.75, conversions: 2 },
      });
      expect(daily[1]).toMatchObject({ bucketStart: '2026-10-26T00:00:00.000Z', observationCount: 1 });
    });

    it('re-rolls up after a restatement', async () => {
      const store = await create();
      const accountId = uniqueName('act');
      const window = { bucket: 'hour' as const, from: '2026-10-25T10:00:00.000Z', to: '2026-10-25T11:00:00.000Z' };
      await store.upsertObservations([makeObservation({ accountId, revision: 0, metrics: { impressions: 100, clicks: 1, spend: 1, conversions: 0 } })]);
      await store.computeRollups(window);
      await store.upsertObservations([makeObservation({ accountId, revision: 1, metrics: { impressions: 300, clicks: 3, spend: 3, conversions: 0 } })]);
      await store.computeRollups(window);
      const rollups = await store.queryRollups({ bucket: 'hour', accountId });
      expect(rollups).toHaveLength(1);
      expect(rollups[0].metrics.impressions).toBe(300);
    });
  });
}
