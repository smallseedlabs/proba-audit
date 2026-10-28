import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { MetricsStore } from '../ports/metrics-store.js';
import { makeObservation, sleep, uniqueName } from './fixtures.js';

export interface MetricsStoreHarness {
  store: MetricsStore;
  cleanup?: () => Promise<void>;
}

/**
 * Contract any MetricsStore adapter must satisfy. Each test uses its own
 * workspace and accountId so one shared database can run the whole suite.
 */
export function runMetricsStoreContract(name: string, factory: () => Promise<MetricsStoreHarness>): void {
  describe(`MetricsStore contract: ${name}`, () => {
    const harnesses: MetricsStoreHarness[] = [];
    let ws = '';
    beforeEach(() => {
      ws = uniqueName('ws');
    });
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
      expect(await store.upsertObservations(ws, [full, minimal])).toEqual({ written: 2, skippedStale: 0 });
      const got = await store.queryObservations({ workspaceId: ws, accountId });
      expect(got).toEqual([minimal, full]);
    });

    it('keeps the highest revision and skips stale ones', async () => {
      const store = await create();
      const accountId = uniqueName('act');
      const base = { accountId, ...hour(10) };
      await store.upsertObservations(ws, [makeObservation({ ...base, revision: 0, metrics: { impressions: 100, clicks: 1, spend: 1, conversions: 0 } })]);
      expect(
        await store.upsertObservations(ws, [makeObservation({ ...base, revision: 1, metrics: { impressions: 120, clicks: 2, spend: 1.5, conversions: 1 } })])
      ).toEqual({ written: 1, skippedStale: 0 });
      expect(
        await store.upsertObservations(ws, [makeObservation({ ...base, revision: 0, metrics: { impressions: 999, clicks: 9, spend: 9, conversions: 9 } })])
      ).toEqual({ written: 0, skippedStale: 1 });
      const got = await store.queryObservations({ workspaceId: ws, accountId });
      expect(got).toHaveLength(1);
      expect(got[0].revision).toBe(1);
      expect(got[0].metrics.impressions).toBe(120);
    });

    it('accepts the same revision again (idempotent replace)', async () => {
      const store = await create();
      const accountId = uniqueName('act');
      const o = makeObservation({ accountId, revision: 2 });
      await store.upsertObservations(ws, [o]);
      expect(await store.upsertObservations(ws, [o])).toEqual({ written: 1, skippedStale: 0 });
      expect(await store.queryObservations({ workspaceId: ws, accountId })).toEqual([o]);
    });

    it('lets the highest revision win when one batch repeats a key', async () => {
      const store = await create();
      const accountId = uniqueName('act');
      const lo = makeObservation({ accountId, revision: 0 });
      const hi = makeObservation({ accountId, revision: 3, metrics: { impressions: 5, clicks: 5, spend: 5, conversions: 5 } });
      await store.upsertObservations(ws, [hi, lo]);
      const got = await store.queryObservations({ workspaceId: ws, accountId });
      expect(got).toHaveLength(1);
      expect(got[0].revision).toBe(3);
    });

    it('treats campaign, adset and ad level rows as different keys', async () => {
      const store = await create();
      const accountId = uniqueName('act');
      await store.upsertObservations(ws, [
        makeObservation({ accountId }),
        makeObservation({ accountId, adsetId: 'as_1' }),
        makeObservation({ accountId, adsetId: 'as_1', adId: 'ad_1' }),
      ]);
      expect(await store.queryObservations({ workspaceId: ws, accountId })).toHaveLength(3);
      expect(await store.queryObservations({ workspaceId: ws, accountId, adsetId: 'as_1', adId: 'ad_1' })).toHaveLength(1);
    });

    it('filters by platform, campaign, granularity and period', async () => {
      const store = await create();
      const accountId = uniqueName('act');
      await store.upsertObservations(ws, [
        makeObservation({ accountId, ...hour(10) }),
        makeObservation({ accountId, ...hour(11) }),
        makeObservation({ accountId, ...hour(12), campaignId: 'cmp_2' }),
        makeObservation({ accountId, platform: 'google' }),
        makeObservation({ accountId, granularity: 'day', periodStart: '2026-10-25T00:00:00.000Z', periodEnd: '2026-10-26T00:00:00.000Z' }),
      ]);
      expect(await store.queryObservations({ workspaceId: ws, accountId, platform: 'google' })).toHaveLength(1);
      expect(await store.queryObservations({ workspaceId: ws, accountId, campaignId: 'cmp_2' })).toHaveLength(1);
      expect(await store.queryObservations({ workspaceId: ws, accountId, granularity: 'day' })).toHaveLength(1);
      const window = await store.queryObservations({ workspaceId: ws, accountId, platform: 'meta', granularity: 'hour', campaignId: 'cmp_1', from: '2026-10-25T11:00:00.000Z', to: '2026-10-25T12:00:00.000Z' });
      expect(window.map((o) => o.periodStart)).toEqual(['2026-10-25T11:00:00.000Z']);
      expect(await store.queryObservations({ workspaceId: ws, accountId, limit: 2 })).toHaveLength(2);
    });

    it('computes hourly and daily rollups from the latest revisions, idempotently', async () => {
      const store = await create();
      const accountId = uniqueName('act');
      await store.upsertObservations(ws, [
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
      const hourlyWritten = await store.computeRollups({ workspaceId: ws, bucket: 'hour', ...window });
      expect(hourlyWritten).toBeGreaterThanOrEqual(4);
      expect(await store.computeRollups({ workspaceId: ws, bucket: 'hour', ...window })).toBe(hourlyWritten); // idempotent

      const hourly = await store.queryRollups({ workspaceId: ws, bucket: 'hour', accountId });
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

      await store.computeRollups({ workspaceId: ws, bucket: 'day', ...window });
      const daily = await store.queryRollups({ workspaceId: ws, bucket: 'day', accountId });
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
      await store.upsertObservations(ws, [makeObservation({ accountId, revision: 0, metrics: { impressions: 100, clicks: 1, spend: 1, conversions: 0 } })]);
      await store.computeRollups({ workspaceId: ws, ...window });
      await store.upsertObservations(ws, [makeObservation({ accountId, revision: 1, metrics: { impressions: 300, clicks: 3, spend: 3, conversions: 0 } })]);
      await store.computeRollups({ workspaceId: ws, ...window });
      const rollups = await store.queryRollups({ workspaceId: ws, bucket: 'hour', accountId });
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
        await store.upsertObservations(ws, [
          // 23:30-00:30 local on the 25th, then 00:30-01:30 local on the 26th
          makeObservation({ accountId, timezone: 'Asia/Kolkata', ...hourAt('2026-10-25T18:00:00.000Z'), metrics: m(10) }),
          makeObservation({ accountId, timezone: 'Asia/Kolkata', ...hourAt('2026-10-25T19:00:00.000Z'), metrics: m(20) }),
          makeObservation({ accountId, timezone: 'Asia/Kolkata', ...hourAt('2026-10-25T20:00:00.000Z'), metrics: m(40) }),
        ]);
        await store.computeRollups({ workspaceId: ws, bucket: 'day', from: '2026-10-25T18:00:00.000Z', to: '2026-10-25T21:00:00.000Z' });
        const daily = await store.queryRollups({ workspaceId: ws, bucket: 'day', accountId });
        expect(daily.map((d) => [d.bucketStart, d.bucketDate, d.timezone, d.metrics.impressions])).toEqual([
          ['2026-10-24T18:30:00.000Z', '2026-10-25', 'Asia/Kolkata', 10],
          ['2026-10-25T18:30:00.000Z', '2026-10-26', 'Asia/Kolkata', 60],
        ]);
      });

      it('treats observations without a timezone as UTC days', async () => {
        const store = await create();
        const accountId = uniqueName('act');
        await store.upsertObservations(ws, [
          makeObservation({ accountId, ...hourAt('2026-10-25T23:00:00.000Z'), metrics: m(5) }),
          makeObservation({ accountId, ...hourAt('2026-10-26T00:00:00.000Z'), metrics: m(7) }),
        ]);
        await store.computeRollups({ workspaceId: ws, bucket: 'day', from: '2026-10-25T23:00:00.000Z', to: '2026-10-26T01:00:00.000Z' });
        const daily = await store.queryRollups({ workspaceId: ws, bucket: 'day', accountId });
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
        await store.upsertObservations(ws, obs);
        await store.computeRollups({ workspaceId: ws, bucket: 'day', from: '2026-11-01T04:00:00.000Z', to: '2026-11-02T06:00:00.000Z' });
        const daily = await store.queryRollups({ workspaceId: ws, bucket: 'day', accountId });
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
        await store.upsertObservations(ws, obs);
        // The window covers only three of the day's hours.
        await store.computeRollups({ workspaceId: ws, bucket: 'day', from: '2026-10-26T02:30:00.000Z', to: '2026-10-26T05:30:00.000Z' });
        const daily = await store.queryRollups({ workspaceId: ws, bucket: 'day', accountId });
        expect(daily).toHaveLength(1);
        expect(daily[0]).toMatchObject({ bucketStart: '2026-10-25T18:30:00.000Z', observationCount: 24, metrics: { impressions: 48 } });
      });

      it('is correct after a restatement: the daily sum follows the latest revision, never both', async () => {
        const store = await create();
        const accountId = uniqueName('act');
        const window = { bucket: 'day' as const, from: '2026-10-25T00:00:00.000Z', to: '2026-10-26T00:00:00.000Z' };
        const base = (n: number, h: number, revision: number) =>
          makeObservation({ accountId, timezone: 'Europe/London', ...hourAt(`2026-10-25T${String(h).padStart(2, '0')}:00:00.000Z`), revision, metrics: m(n, { spend: n / 10, conversions: n / 100, revenue: n / 5, reach: n }) });
        await store.upsertObservations(ws, [base(100, 10, 0), base(200, 11, 0), base(300, 12, 0)]);
        await store.computeRollups({ workspaceId: ws, ...window });
        let [day] = await store.queryRollups({ workspaceId: ws, bucket: 'day', accountId });
        expect(day.metrics).toMatchObject({ impressions: 600, spend: 60, conversions: 6, revenue: 120 });

        // The platform restates hours 10 and 11 upwards; hour 12 is unchanged.
        await store.upsertObservations(ws, [base(150, 10, 1), base(260, 11, 1)]);
        await store.computeRollups({ workspaceId: ws, ...window });
        await store.computeRollups({ workspaceId: ws, ...window }); // and a second run changes nothing
        const daily = await store.queryRollups({ workspaceId: ws, bucket: 'day', accountId });
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
      await store.upsertObservations(ws, [
        obs({ campaignId: 'c1', adId: 'a1', adsetId: 's1', ...hour(10) }, 1000),
        obs({ campaignId: 'c1', adId: 'a2', adsetId: 's1', ...hour(10) }, 500),
        obs({ campaignId: 'c1', adId: 'a1', adsetId: 's1', ...hour(11) }, 100),
        obs({ campaignId: 'c2', ...hour(10) }, 40),
        obs({ campaignId: 'c3', currency: 'EUR', ...hour(10) }, 30),
        makeObservation({ accountId: other, ...hour(10) }),
      ]);
      const win = { from: '2026-10-25T00:00:00.000Z', to: '2026-10-26T00:00:00.000Z' };
      await store.computeRollups({ workspaceId: ws, bucket: 'hour', ...win });
      await store.computeRollups({ workspaceId: ws, bucket: 'day', ...win });
      const accounts = [{ platform: 'meta' as const, accountId }];

      const byCampaign = await store.aggregateRollups({ workspaceId: ws, bucket: 'hour', ...win, groupBy: ['campaign'], accounts });
      const view = (a: (typeof byCampaign)[number]) => [a.campaignId, a.currency, a.metrics.impressions, a.metrics.clicks, a.metrics.spend, a.observationCount];
      expect(byCampaign.map(view)).toEqual([
        ['c1', 'USD', 1600, 160, 16, 3],
        ['c2', 'USD', 40, 4, 0.4, 1],
        ['c3', 'EUR', 30, 3, 0.3, 1],
      ]);
      for (const a of byCampaign) expect('reach' in a.metrics).toBe(false);

      const total = await store.aggregateRollups({ workspaceId: ws, bucket: 'hour', ...win, groupBy: [], accounts });
      expect(total.map((a) => [a.currency, a.metrics.impressions]).sort()).toEqual([['EUR', 30], ['USD', 1640]]);

      const series = await store.aggregateRollups({ workspaceId: ws, bucket: 'hour', ...win, groupBy: ['bucket'], accounts, campaignId: 'c1' });
      expect(series.map((a) => [a.bucket, a.metrics.impressions])).toEqual([
        ['2026-10-25T10:00:00.000Z', 1500],
        ['2026-10-25T11:00:00.000Z', 100],
      ]);

      const daily = await store.aggregateRollups({ workspaceId: ws, bucket: 'day', ...win, groupBy: ['account', 'bucket'], accounts });
      expect(daily.map((a) => [a.accountId, a.bucket, a.currency, a.metrics.impressions]).sort()).toEqual(
        [[accountId, '2026-10-25', 'EUR', 30], [accountId, '2026-10-25', 'USD', 1640]].sort()
      );

      const onlyDaySource = await store.aggregateRollups({ workspaceId: ws, bucket: 'hour', ...win, groupBy: [], accounts, sourceGranularity: 'day' });
      expect(onlyDaySource).toEqual([]);
      const onlyHourSource = await store.aggregateRollups({ workspaceId: ws, bucket: 'hour', ...win, groupBy: [], accounts, sourceGranularity: 'hour' });
      expect(onlyHourSource.map((a) => a.currency).sort()).toEqual(['EUR', 'USD']);

      // Narrowed to a list of campaigns: only those, in every grouping; an empty list sees nothing; with campaignId both must hold.
      const only = await store.aggregateRollups({ workspaceId: ws, bucket: 'hour', ...win, groupBy: ['campaign'], accounts, campaignIds: ['c2', 'c3', 'c-unknown'] });
      expect(only.map((a) => a.campaignId)).toEqual(['c2', 'c3']);
      const onlyTotal = await store.aggregateRollups({ workspaceId: ws, bucket: 'hour', ...win, groupBy: [], accounts, campaignIds: ['c2'] });
      expect(onlyTotal.map((a) => [a.currency, a.metrics.impressions])).toEqual([['USD', 40]]);
      const onlyDaily = await store.aggregateRollups({ workspaceId: ws, bucket: 'day', ...win, groupBy: ['campaign'], accounts, campaignIds: ['c1'] });
      expect(onlyDaily.map((a) => [a.campaignId, a.metrics.impressions])).toEqual([['c1', 1600]]);
      expect(await store.aggregateRollups({ workspaceId: ws, bucket: 'hour', ...win, groupBy: ['campaign'], accounts, campaignIds: [] })).toEqual([]);
      expect(await store.aggregateRollups({ workspaceId: ws, bucket: 'hour', ...win, groupBy: ['campaign'], accounts, campaignIds: ['c1'], campaignId: 'c2' })).toEqual([]);
      expect(await store.aggregateRollups({ workspaceId: ws, bucket: 'hour', ...win, groupBy: ['campaign'], campaignIds: ["c1') OR 1=1 --"] })).toEqual([]);

      expect(await store.aggregateRollups({ workspaceId: ws, bucket: 'hour', ...win, groupBy: ['campaign'], accounts: [] })).toEqual([]);
      expect(await store.aggregateRollups({ workspaceId: ws, bucket: 'hour', ...win, groupBy: ['campaign'], accounts: [{ platform: 'meta', accountId: uniqueName('none') }] })).toEqual([]);
    });

    it('reports the window of observations written since a watermark', async () => {
      const store = await create();
      const accountId = uniqueName('act');
      const mark = (await store.changedSince(ws))?.watermark;
      await store.upsertObservations(ws, [
        makeObservation({ accountId, ...hour(3) }),
        makeObservation({ accountId, ...hour(7) }),
      ]);
      const changed = await store.changedSince(ws, mark);
      expect(changed).not.toBeNull();
      expect(changed!.observationCount).toBeGreaterThanOrEqual(2);
      expect(Date.parse(changed!.from)).toBeLessThanOrEqual(Date.parse('2026-10-25T03:00:00.000Z'));
      expect(Date.parse(changed!.to)).toBeGreaterThanOrEqual(Date.parse('2026-10-25T08:00:00.000Z'));

      // Once the watermark has caught up, nothing is reported until something new is written.
      let settled = changed!.watermark;
      for (let i = 0; i < 40; i += 1) {
        const again = await store.changedSince(ws, settled);
        if (again === null) break;
        settled = again.watermark;
        await sleep(250);
      }
      expect(await store.changedSince(ws, settled)).toBeNull();
      await store.upsertObservations(ws, [makeObservation({ accountId, ...hour(8) })]);
      expect((await store.changedSince(ws, settled))?.observationCount).toBeGreaterThanOrEqual(1);
    });

    it('reports how fresh the data of the given accounts is', async () => {
      const store = await create();
      const accountId = uniqueName('act');
      const otherId = uniqueName('act');
      const scope = [{ platform: 'meta' as const, accountId }];
      expect(await store.getFreshness(ws, scope)).toEqual({ rollupsComputedAt: null, observationsFetchedAt: null });
      expect(await store.getFreshness(ws, [])).toEqual({ rollupsComputedAt: null, observationsFetchedAt: null });

      await store.upsertObservations(ws, [
        makeObservation({ accountId, ...hour(3), fetchedAt: '2026-10-25T04:00:00.000Z' }),
        makeObservation({ accountId, ...hour(4), fetchedAt: '2026-10-25T05:30:00.000Z' }),
        makeObservation({ accountId: otherId, ...hour(5), fetchedAt: '2026-10-26T09:00:00.000Z' }),
      ]);
      // A restatement fetched later moves the time forward; the superseded revision does not count twice.
      await store.upsertObservations(ws, [makeObservation({ accountId, ...hour(3), revision: 1, fetchedAt: '2026-10-25T06:15:00.000Z' })]);
      const beforeRollup = await store.getFreshness(ws, scope);
      expect(beforeRollup).toEqual({ rollupsComputedAt: null, observationsFetchedAt: '2026-10-25T06:15:00.000Z' });

      await store.computeRollups({ workspaceId: ws, bucket: 'hour', from: '2026-10-25T00:00:00.000Z', to: '2026-10-26T00:00:00.000Z' });
      const afterRollup = await store.getFreshness(ws, scope);
      expect(afterRollup.observationsFetchedAt).toBe('2026-10-25T06:15:00.000Z');
      expect(afterRollup.rollupsComputedAt).not.toBeNull();
      expect(Math.abs(Date.now() - Date.parse(afterRollup.rollupsComputedAt as string))).toBeLessThan(60_000);
      // Another account's fetch (2026-10-26) never leaks in.
      expect((await store.getFreshness(ws, [{ platform: 'google', accountId }])).observationsFetchedAt).toBeNull();
    });

    // The same platform account, campaign and period exist in two workspaces with different numbers. Every read
    // path must return the caller's workspace only, and a write in one must never replace or skip a row of the other.
    describe('workspace isolation', () => {
      const win = { from: '2026-10-25T00:00:00.000Z', to: '2026-10-26T00:00:00.000Z' };

      async function twoWorkspaces(): Promise<{ store: MetricsStore; a: string; b: string; accountId: string; accounts: { platform: 'meta'; accountId: string }[] }> {
        const store = await create();
        const a = uniqueName('wsa');
        const b = uniqueName('wsb');
        const accountId = uniqueName('act');
        const m = (n: number) => ({ impressions: n, clicks: Math.floor(n / 10), spend: n / 100, conversions: 1 });
        await store.upsertObservations(a, [makeObservation({ accountId, ...hour(10), timezone: 'Europe/London', metrics: m(1000) }), makeObservation({ accountId, ...hour(11), timezone: 'Europe/London', metrics: m(10) })]);
        await store.upsertObservations(b, [makeObservation({ accountId, ...hour(10), timezone: 'Europe/London', metrics: m(7) })]);
        return { store, a, b, accountId, accounts: [{ platform: 'meta', accountId }] };
      }

      it('queryObservations returns only the workspace asked for', async () => {
        const { store, a, b, accountId } = await twoWorkspaces();
        expect((await store.queryObservations({ workspaceId: a, accountId })).map((o) => o.metrics.impressions)).toEqual([1000, 10]);
        expect((await store.queryObservations({ workspaceId: b, accountId })).map((o) => o.metrics.impressions)).toEqual([7]);
        expect(await store.queryObservations({ workspaceId: uniqueName('wsc'), accountId })).toEqual([]);
        // No other filter narrows the workspace away: even an unfiltered read is scoped.
        expect(await store.queryObservations({ workspaceId: b })).toHaveLength(1);
      });

      it('a write in one workspace neither replaces nor is judged stale against another', async () => {
        const { store, a, b, accountId } = await twoWorkspaces();
        // b restates the hour to revision 5; a still holds revision 0 and a revision-0 rewrite of a is not stale.
        expect(await store.upsertObservations(b, [makeObservation({ accountId, ...hour(10), revision: 5, metrics: { impressions: 99, clicks: 1, spend: 1, conversions: 0 } })])).toEqual({ written: 1, skippedStale: 0 });
        expect(await store.upsertObservations(a, [makeObservation({ accountId, ...hour(10), revision: 0, metrics: { impressions: 1001, clicks: 1, spend: 1, conversions: 0 } })])).toEqual({ written: 1, skippedStale: 0 });
        expect((await store.queryObservations({ workspaceId: a, accountId, from: '2026-10-25T10:00:00.000Z', to: '2026-10-25T11:00:00.000Z' }))[0]).toMatchObject({ revision: 0, metrics: { impressions: 1001 } });
        expect((await store.queryObservations({ workspaceId: b, accountId }))[0]).toMatchObject({ revision: 5, metrics: { impressions: 99 } });
      });

      it('computeRollups rolls up the requested workspace only', async () => {
        const { store, a, b, accountId } = await twoWorkspaces();
        for (const bucket of ['hour', 'day'] as const) {
          expect(await store.computeRollups({ workspaceId: a, bucket, ...win })).toBeGreaterThan(0);
          expect(await store.queryRollups({ workspaceId: b, bucket, accountId })).toEqual([]);
          expect(await store.computeRollups({ workspaceId: uniqueName('wsc'), bucket, ...win })).toBe(0);
        }
        await store.computeRollups({ workspaceId: b, bucket: 'day', ...win });
        const dayB = await store.queryRollups({ workspaceId: b, bucket: 'day', accountId });
        expect(dayB.map((r) => [r.observationCount, r.metrics.impressions])).toEqual([[1, 7]]);
        const dayA = await store.queryRollups({ workspaceId: a, bucket: 'day', accountId });
        expect(dayA.map((r) => [r.observationCount, r.metrics.impressions])).toEqual([[2, 1010]]);
      });

      it('queryRollups returns only the workspace asked for', async () => {
        const { store, a, b, accountId } = await twoWorkspaces();
        for (const ws of [a, b]) for (const bucket of ['hour', 'day'] as const) await store.computeRollups({ workspaceId: ws, bucket, ...win });
        expect((await store.queryRollups({ workspaceId: a, bucket: 'hour', accountId })).map((r) => r.metrics.impressions)).toEqual([1000, 10]);
        expect((await store.queryRollups({ workspaceId: b, bucket: 'hour', accountId })).map((r) => r.metrics.impressions)).toEqual([7]);
        expect((await store.queryRollups({ workspaceId: b, bucket: 'day' })).map((r) => r.metrics.impressions)).toEqual([7]);
        expect(await store.queryRollups({ workspaceId: uniqueName('wsc'), bucket: 'hour', accountId })).toEqual([]);
      });

      it('aggregateRollups sums the workspace asked for and nothing else, with or without an account scope', async () => {
        const { store, a, b, accountId, accounts } = await twoWorkspaces();
        for (const ws of [a, b]) for (const bucket of ['hour', 'day'] as const) await store.computeRollups({ workspaceId: ws, bucket, ...win });
        for (const bucket of ['hour', 'day'] as const) {
          for (const scope of [{ accounts }, {}]) {
            const sumA = await store.aggregateRollups({ workspaceId: a, bucket, ...win, groupBy: ['account'], ...scope });
            const sumB = await store.aggregateRollups({ workspaceId: b, bucket, ...win, groupBy: ['account'], ...scope });
            expect(sumA.filter((r) => r.accountId === accountId).map((r) => r.metrics.impressions)).toEqual([1010]);
            expect(sumB.filter((r) => r.accountId === accountId).map((r) => r.metrics.impressions)).toEqual([7]);
            expect(await store.aggregateRollups({ workspaceId: uniqueName('wsc'), bucket, ...win, groupBy: [], ...scope })).toEqual([]);
          }
        }
      });

      it('getFreshness and changedSince see only the workspace asked for', async () => {
        const { store, a, accounts } = await twoWorkspaces();
        const empty = uniqueName('wsc');
        await store.computeRollups({ workspaceId: a, bucket: 'hour', ...win });
        expect((await store.getFreshness(a, accounts)).rollupsComputedAt).not.toBeNull();
        expect(await store.getFreshness(empty, accounts)).toEqual({ rollupsComputedAt: null, observationsFetchedAt: null });
        expect(await store.changedSince(empty)).toBeNull();
        expect((await store.changedSince(a))?.observationCount).toBe(2);
      });
    });
  });
}
