import { afterEach, describe, expect, it } from 'vitest';
import type { MetricsStore } from '../ports/metrics-store.js';
import { makeObservation, sleep, uniqueName } from './fixtures.js';

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

    describe('daily rollups cut in the account timezone', () => {
      const m = (n: number, extra = {}) => ({ impressions: n, clicks: 1, spend: 1, conversions: 0, ...extra });
      const hourAt = (iso: string) => ({
        periodStart: iso,
        periodEnd: new Date(Date.parse(iso) + 3_600_000).toISOString(),
      });

      it('cuts days at local midnight (Asia/Kolkata, +05:30) and labels them with the local date', async () => {
        const store = await create();
        const accountId = uniqueName('act');
        await store.upsertObservations([
          // 23:30-00:30 local on the 25th, then 00:30-01:30 local on the 26th
          makeObservation({ accountId, timezone: 'Asia/Kolkata', ...hourAt('2026-10-25T18:00:00.000Z'), metrics: m(10) }),
          makeObservation({ accountId, timezone: 'Asia/Kolkata', ...hourAt('2026-10-25T19:00:00.000Z'), metrics: m(20) }),
          makeObservation({ accountId, timezone: 'Asia/Kolkata', ...hourAt('2026-10-25T20:00:00.000Z'), metrics: m(40) }),
        ]);
        await store.computeRollups({ bucket: 'day', from: '2026-10-25T18:00:00.000Z', to: '2026-10-25T21:00:00.000Z' });
        const daily = await store.queryRollups({ bucket: 'day', accountId });
        expect(daily.map((d) => [d.bucketStart, d.bucketDate, d.timezone, d.metrics.impressions])).toEqual([
          ['2026-10-24T18:30:00.000Z', '2026-10-25', 'Asia/Kolkata', 10],
          ['2026-10-25T18:30:00.000Z', '2026-10-26', 'Asia/Kolkata', 60],
        ]);
      });

      it('treats observations without a timezone as UTC days', async () => {
        const store = await create();
        const accountId = uniqueName('act');
        await store.upsertObservations([
          makeObservation({ accountId, ...hourAt('2026-10-25T23:00:00.000Z'), metrics: m(5) }),
          makeObservation({ accountId, ...hourAt('2026-10-26T00:00:00.000Z'), metrics: m(7) }),
        ]);
        await store.computeRollups({ bucket: 'day', from: '2026-10-25T23:00:00.000Z', to: '2026-10-26T01:00:00.000Z' });
        const daily = await store.queryRollups({ bucket: 'day', accountId });
        expect(daily.map((d) => [d.bucketStart, d.bucketDate, d.timezone, d.metrics.impressions])).toEqual([
          ['2026-10-25T00:00:00.000Z', '2026-10-25', 'UTC', 5],
          ['2026-10-26T00:00:00.000Z', '2026-10-26', 'UTC', 7],
        ]);
      });

      it('handles a 25-hour day (America/New_York, DST ends 2026-11-01)', async () => {
        const store = await create();
        const accountId = uniqueName('act');
        const obs = [];
        // Local 1 Nov 2026 runs from 04:00Z to 05:00Z the next day: 25 hours.
        for (let h = 0; h < 25; h += 1) {
          obs.push(makeObservation({ accountId, timezone: 'America/New_York', ...hourAt(new Date(Date.parse('2026-11-01T04:00:00.000Z') + h * 3_600_000).toISOString()), metrics: m(1) }));
        }
        obs.push(makeObservation({ accountId, timezone: 'America/New_York', ...hourAt('2026-11-02T05:00:00.000Z'), metrics: m(100) }));
        await store.upsertObservations(obs);
        await store.computeRollups({ bucket: 'day', from: '2026-11-01T04:00:00.000Z', to: '2026-11-02T06:00:00.000Z' });
        const daily = await store.queryRollups({ bucket: 'day', accountId });
        expect(daily.map((d) => [d.bucketStart, d.bucketDate, d.observationCount, d.metrics.impressions])).toEqual([
          ['2026-11-01T04:00:00.000Z', '2026-11-01', 25, 25],
          ['2026-11-02T05:00:00.000Z', '2026-11-02', 1, 100],
        ]);
      });

      it('never writes a partial day when the window covers only part of it', async () => {
        const store = await create();
        const accountId = uniqueName('act');
        const obs = [];
        for (let h = 0; h < 24; h += 1) {
          obs.push(makeObservation({ accountId, timezone: 'Asia/Kolkata', ...hourAt(new Date(Date.parse('2026-10-25T18:30:00.000Z') + h * 3_600_000).toISOString()), metrics: m(2) }));
        }
        await store.upsertObservations(obs);
        // The window covers only three of the day's hours.
        await store.computeRollups({ bucket: 'day', from: '2026-10-26T02:30:00.000Z', to: '2026-10-26T05:30:00.000Z' });
        const daily = await store.queryRollups({ bucket: 'day', accountId });
        expect(daily).toHaveLength(1);
        expect(daily[0]).toMatchObject({ bucketStart: '2026-10-25T18:30:00.000Z', observationCount: 24, metrics: { impressions: 48 } });
      });

      it('is correct after a restatement: the daily sum follows the latest revision, never both', async () => {
        const store = await create();
        const accountId = uniqueName('act');
        const window = { bucket: 'day' as const, from: '2026-10-25T00:00:00.000Z', to: '2026-10-26T00:00:00.000Z' };
        const base = (n: number, h: number, revision: number) =>
          makeObservation({ accountId, timezone: 'Europe/London', ...hourAt(`2026-10-25T${String(h).padStart(2, '0')}:00:00.000Z`), revision, metrics: m(n, { spend: n / 10, conversions: n / 100, revenue: n / 5, reach: n }) });
        await store.upsertObservations([base(100, 10, 0), base(200, 11, 0), base(300, 12, 0)]);
        await store.computeRollups(window);
        let [day] = await store.queryRollups({ bucket: 'day', accountId });
        expect(day.metrics).toMatchObject({ impressions: 600, spend: 60, conversions: 6, revenue: 120 });

        // The platform restates hours 10 and 11 upwards; hour 12 is unchanged.
        await store.upsertObservations([base(150, 10, 1), base(260, 11, 1)]);
        await store.computeRollups(window);
        await store.computeRollups(window); // and a second run changes nothing
        const daily = await store.queryRollups({ bucket: 'day', accountId });
        expect(daily).toHaveLength(1);
        [day] = daily;
        expect(day.observationCount).toBe(3);
        expect(day.metrics).toMatchObject({ impressions: 710, spend: 71, conversions: 7.1, revenue: 142 });
        expect('reach' in day.metrics).toBe(false);
      });
    });

    it('aggregates rollups per campaign, account and bucket without mixing currencies', async () => {
      const store = await create();
      const accountId = uniqueName('act');
      const other = uniqueName('act');
      const obs = (extra: object, n: number) => makeObservation({ accountId, timezone: 'Europe/London', metrics: { impressions: n, clicks: n / 10, spend: n / 100, conversions: 1, reach: n, revenue: n }, ...extra });
      await store.upsertObservations([
        obs({ campaignId: 'c1', adId: 'a1', adsetId: 's1', ...hour(10) }, 1000),
        obs({ campaignId: 'c1', adId: 'a2', adsetId: 's1', ...hour(10) }, 500),
        obs({ campaignId: 'c1', adId: 'a1', adsetId: 's1', ...hour(11) }, 100),
        obs({ campaignId: 'c2', ...hour(10) }, 40),
        obs({ campaignId: 'c3', currency: 'EUR', ...hour(10) }, 30),
        makeObservation({ accountId: other, ...hour(10) }),
      ]);
      const win = { from: '2026-10-25T00:00:00.000Z', to: '2026-10-26T00:00:00.000Z' };
      await store.computeRollups({ bucket: 'hour', ...win });
      await store.computeRollups({ bucket: 'day', ...win });
      const accounts = [{ platform: 'meta' as const, accountId }];

      const byCampaign = await store.aggregateRollups({ bucket: 'hour', ...win, groupBy: ['campaign'], accounts });
      const view = (a: (typeof byCampaign)[number]) => [a.campaignId, a.currency, a.metrics.impressions, a.metrics.clicks, a.metrics.spend, a.observationCount];
      expect(byCampaign.map(view)).toEqual([
        ['c1', 'USD', 1600, 160, 16, 3],
        ['c2', 'USD', 40, 4, 0.4, 1],
        ['c3', 'EUR', 30, 3, 0.3, 1],
      ]);
      for (const a of byCampaign) expect('reach' in a.metrics).toBe(false);

      const total = await store.aggregateRollups({ bucket: 'hour', ...win, groupBy: [], accounts });
      expect(total.map((a) => [a.currency, a.metrics.impressions]).sort()).toEqual([['EUR', 30], ['USD', 1640]]);

      const series = await store.aggregateRollups({ bucket: 'hour', ...win, groupBy: ['bucket'], accounts, campaignId: 'c1' });
      expect(series.map((a) => [a.bucket, a.metrics.impressions])).toEqual([
        ['2026-10-25T10:00:00.000Z', 1500],
        ['2026-10-25T11:00:00.000Z', 100],
      ]);

      const daily = await store.aggregateRollups({ bucket: 'day', ...win, groupBy: ['account', 'bucket'], accounts });
      expect(daily.map((a) => [a.accountId, a.bucket, a.currency, a.metrics.impressions]).sort()).toEqual(
        [[accountId, '2026-10-25', 'EUR', 30], [accountId, '2026-10-25', 'USD', 1640]].sort()
      );

      const onlyDaySource = await store.aggregateRollups({ bucket: 'hour', ...win, groupBy: [], accounts, sourceGranularity: 'day' });
      expect(onlyDaySource).toEqual([]);
      const onlyHourSource = await store.aggregateRollups({ bucket: 'hour', ...win, groupBy: [], accounts, sourceGranularity: 'hour' });
      expect(onlyHourSource.map((a) => a.currency).sort()).toEqual(['EUR', 'USD']);

      expect(await store.aggregateRollups({ bucket: 'hour', ...win, groupBy: ['campaign'], accounts: [] })).toEqual([]);
      expect(await store.aggregateRollups({ bucket: 'hour', ...win, groupBy: ['campaign'], accounts: [{ platform: 'meta', accountId: uniqueName('none') }] })).toEqual([]);
    });

    it('reports the window of observations written since a watermark', async () => {
      const store = await create();
      const accountId = uniqueName('act');
      const mark = (await store.changedSince())?.watermark;
      await store.upsertObservations([
        makeObservation({ accountId, ...hour(3) }),
        makeObservation({ accountId, ...hour(7) }),
      ]);
      const changed = await store.changedSince(mark);
      expect(changed).not.toBeNull();
      expect(changed!.observationCount).toBeGreaterThanOrEqual(2);
      expect(Date.parse(changed!.from)).toBeLessThanOrEqual(Date.parse('2026-10-25T03:00:00.000Z'));
      expect(Date.parse(changed!.to)).toBeGreaterThanOrEqual(Date.parse('2026-10-25T08:00:00.000Z'));

      // Once the watermark has caught up, nothing is reported until something new is written.
      let settled = changed!.watermark;
      for (let i = 0; i < 40; i += 1) {
        const again = await store.changedSince(settled);
        if (again === null) break;
        settled = again.watermark;
        await sleep(250);
      }
      expect(await store.changedSince(settled)).toBeNull();
      await store.upsertObservations([makeObservation({ accountId, ...hour(8) })]);
      expect((await store.changedSince(settled))?.observationCount).toBeGreaterThanOrEqual(1);
    });
  });
}
