import {
  METRIC_QUERY_DEFAULT_LIMIT,
  METRIC_QUERY_MAX_LIMIT,
  alignWindow,
  bucketStart,
  dayBucket,
  type AccountRef,
  type ChangedWindow,
  type MetricsFreshness,
  type Clock,
  type MetricAggregate,
  type RollupAggregateFilter,
  type MetricObservation,
  type MetricObservationFilter,
  type MetricRollup,
  type MetricsStore,
  type RollupFilter,
  type RollupRequest,
  type UpsertResult,
} from '@smallseedlabs/proba-audit-core';
import { SystemClock } from '../runtime/system.js';

export function observationKey(o: MetricObservation): string {
  return [o.platform, o.accountId, o.campaignId, o.adsetId ?? '', o.adId ?? '', o.granularity, o.periodStart].join('|');
}

function matches(o: MetricObservation, f: MetricObservationFilter): boolean {
  return (
    (f.platform === undefined || o.platform === f.platform) &&
    (f.accountId === undefined || o.accountId === f.accountId) &&
    (f.campaignId === undefined || o.campaignId === f.campaignId) &&
    (f.adsetId === undefined || (o.adsetId ?? '') === f.adsetId) &&
    (f.adId === undefined || (o.adId ?? '') === f.adId) &&
    (f.granularity === undefined || o.granularity === f.granularity) &&
    (f.from === undefined || Date.parse(o.periodStart) >= Date.parse(f.from)) &&
    (f.to === undefined || Date.parse(o.periodStart) < Date.parse(f.to))
  );
}

/** In-process MetricsStore following the port's semantics. For tests and local runs. */
export class InMemoryMetricsStore implements MetricsStore {
  private readonly observations = new Map<string, MetricObservation>();
  private readonly rollups = new Map<string, MetricRollup>();
  /** Insertion sequence per key: lets changedSince work without a wall clock. */
  private readonly inserted = new Map<string, number>();
  private seq = 0;

  constructor(private readonly clock: Clock = new SystemClock()) {}

  async upsertObservations(observations: MetricObservation[]): Promise<UpsertResult> {
    // Highest revision per key within the batch wins.
    const batch = new Map<string, MetricObservation>();
    for (const o of observations) {
      const k = observationKey(o);
      const prev = batch.get(k);
      if (!prev || o.revision >= prev.revision) batch.set(k, o);
    }
    let written = 0;
    let skippedStale = 0;
    for (const [k, o] of batch) {
      const stored = this.observations.get(k);
      if (stored && stored.revision > o.revision) {
        skippedStale += 1;
      } else {
        this.observations.set(k, structuredClone(o));
        this.seq += 1;
        this.inserted.set(k, this.seq);
        written += 1;
      }
    }
    return { written, skippedStale };
  }

  async queryObservations(filter: MetricObservationFilter): Promise<MetricObservation[]> {
    const limit = Math.min(filter.limit ?? METRIC_QUERY_DEFAULT_LIMIT, METRIC_QUERY_MAX_LIMIT);
    return [...this.observations.entries()]
      .filter(([, o]) => matches(o, filter))
      .sort(([ka, a], [kb, b]) => a.periodStart.localeCompare(b.periodStart) || ka.localeCompare(kb))
      .slice(0, limit)
      .map(([, o]) => structuredClone(o));
  }

  async computeRollups(request: RollupRequest): Promise<number> {
    const { from, to } = alignWindow(request.from, request.to, request.bucket);
    const computedAt = this.clock.isoNow();
    const inWindow = (o: MetricObservation): boolean =>
      Date.parse(o.periodStart) >= Date.parse(from) && Date.parse(o.periodStart) < Date.parse(to);
    // An hourly rollup only summarises hourly observations.
    const eligible = (o: MetricObservation): boolean => request.bucket === 'day' || o.granularity === 'hour';
    const bucketOf = (o: MetricObservation): { start: string; date?: string; tz?: string } => {
      if (request.bucket === 'hour') return { start: bucketStart(o.periodStart, 'hour') };
      const tz = o.timezone ?? 'UTC';
      const day = dayBucket(o.periodStart, tz);
      return { start: day.start, date: day.date, tz };
    };

    // Buckets touched by the window. A daily bucket is always summed whole, from every
    // observation in it, even those outside the window (a local day can straddle it).
    const touched = new Set<string>();
    for (const o of this.observations.values()) {
      if (!inWindow(o) || !eligible(o)) continue;
      touched.add(`${bucketOf(o).tz ?? ''}|${bucketOf(o).start}`);
    }

    const groups = new Map<string, MetricRollup>();
    for (const o of this.observations.values()) {
      if (!eligible(o)) continue;
      const b = bucketOf(o);
      if (!touched.has(`${b.tz ?? ''}|${b.start}`)) continue;
      const id = [o.platform, o.accountId, o.campaignId, o.adsetId ?? '', o.adId ?? '', o.granularity, b.start, o.currency].join('|');
      let r = groups.get(id);
      if (!r) {
        r = {
          platform: o.platform,
          accountId: o.accountId,
          campaignId: o.campaignId,
          ...(o.adsetId ? { adsetId: o.adsetId } : {}),
          ...(o.adId ? { adId: o.adId } : {}),
          sourceGranularity: o.granularity,
          bucket: request.bucket,
          bucketStart: b.start,
          ...(b.date !== undefined ? { timezone: b.tz, bucketDate: b.date } : {}),
          currency: o.currency,
          metrics: { impressions: 0, clicks: 0, spend: 0, conversions: 0 },
          observationCount: 0,
          computedAt,
        };
        groups.set(id, r);
      }
      r.metrics.impressions += o.metrics.impressions;
      r.metrics.clicks += o.metrics.clicks;
      r.metrics.spend += o.metrics.spend;
      r.metrics.conversions += o.metrics.conversions;
      if (o.metrics.videoViews !== undefined) r.metrics.videoViews = (r.metrics.videoViews ?? 0) + o.metrics.videoViews;
      if (o.metrics.revenue !== undefined) r.metrics.revenue = (r.metrics.revenue ?? 0) + o.metrics.revenue;
      r.observationCount += 1;
    }
    for (const [id, r] of groups) {
      r.metrics.spend = Math.round(r.metrics.spend * 1e6) / 1e6;
      if (r.metrics.revenue !== undefined) r.metrics.revenue = Math.round(r.metrics.revenue * 1e6) / 1e6;
      this.rollups.set(`${request.bucket}|${id}`, r);
    }
    return groups.size;
  }

  async queryRollups(filter: RollupFilter): Promise<MetricRollup[]> {
    const limit = Math.min(filter.limit ?? METRIC_QUERY_DEFAULT_LIMIT, METRIC_QUERY_MAX_LIMIT);
    return [...this.rollups.entries()]
      .filter(
        ([, r]) =>
          r.bucket === filter.bucket &&
          (filter.platform === undefined || r.platform === filter.platform) &&
          (filter.accountId === undefined || r.accountId === filter.accountId) &&
          (filter.campaignId === undefined || r.campaignId === filter.campaignId) &&
          (filter.adsetId === undefined || (r.adsetId ?? '') === filter.adsetId) &&
          (filter.adId === undefined || (r.adId ?? '') === filter.adId) &&
          (filter.sourceGranularity === undefined || r.sourceGranularity === filter.sourceGranularity) &&
          (filter.from === undefined || Date.parse(r.bucketStart) >= Date.parse(filter.from)) &&
          (filter.to === undefined || Date.parse(r.bucketStart) < Date.parse(filter.to))
      )
      .sort(([ka, a], [kb, b]) => a.bucketStart.localeCompare(b.bucketStart) || ka.localeCompare(kb))
      .slice(0, limit)
      .map(([, r]) => structuredClone(r));
  }

  async aggregateRollups(filter: RollupAggregateFilter): Promise<MetricAggregate[]> {
    const limit = Math.min(filter.limit ?? METRIC_QUERY_DEFAULT_LIMIT, METRIC_QUERY_MAX_LIMIT);
    const accounts = filter.accounts === undefined ? undefined : new Set(filter.accounts.map((a) => `${a.platform}|${a.accountId}`));
    const dims = new Set(filter.groupBy);
    const groups = new Map<string, MetricAggregate & { hasVideo: boolean; hasRevenue: boolean }>();
    for (const r of this.rollups.values()) {
      if (r.bucket !== filter.bucket) continue;
      if (filter.bucket === 'day') {
        const date = r.bucketDate ?? r.bucketStart.slice(0, 10);
        if (date < filter.from.slice(0, 10) || date >= filter.to.slice(0, 10)) continue;
      } else if (Date.parse(r.bucketStart) < Date.parse(filter.from) || Date.parse(r.bucketStart) >= Date.parse(filter.to)) {
        continue;
      }
      if (accounts && !accounts.has(`${r.platform}|${r.accountId}`)) continue;
      if (filter.campaignId !== undefined && r.campaignId !== filter.campaignId) continue;
      if (filter.sourceGranularity !== undefined && r.sourceGranularity !== filter.sourceGranularity) continue;
      const bucket = dims.has('bucket') ? (filter.bucket === 'day' ? (r.bucketDate ?? r.bucketStart.slice(0, 10)) : r.bucketStart) : undefined;
      const id = [
        dims.has('platform') ? r.platform : '',
        dims.has('account') ? r.accountId : '',
        dims.has('campaign') ? r.campaignId : '',
        bucket ?? '',
        r.sourceGranularity,
        r.currency,
      ].join('|');
      let g = groups.get(id);
      if (!g) {
        g = {
          ...(dims.has('platform') ? { platform: r.platform } : {}),
          ...(dims.has('account') ? { accountId: r.accountId } : {}),
          ...(dims.has('campaign') ? { campaignId: r.campaignId } : {}),
          ...(bucket !== undefined ? { bucket } : {}),
          sourceGranularity: r.sourceGranularity,
          currency: r.currency,
          metrics: { impressions: 0, clicks: 0, spend: 0, conversions: 0 },
          observationCount: 0,
          hasVideo: false,
          hasRevenue: false,
        };
        groups.set(id, g);
      }
      g.metrics.impressions += r.metrics.impressions;
      g.metrics.clicks += r.metrics.clicks;
      g.metrics.spend += r.metrics.spend;
      g.metrics.conversions += r.metrics.conversions;
      if (r.metrics.videoViews !== undefined) {
        g.metrics.videoViews = (g.metrics.videoViews ?? 0) + r.metrics.videoViews;
        g.hasVideo = true;
      }
      if (r.metrics.revenue !== undefined) {
        g.metrics.revenue = (g.metrics.revenue ?? 0) + r.metrics.revenue;
        g.hasRevenue = true;
      }
      g.observationCount += r.observationCount;
    }
    return [...groups.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .slice(0, limit)
      .map(([, g]) => {
        const { hasVideo: _v, hasRevenue: _r, ...rest } = g;
        rest.metrics.spend = Math.round(rest.metrics.spend * 1e6) / 1e6;
        if (rest.metrics.revenue !== undefined) rest.metrics.revenue = Math.round(rest.metrics.revenue * 1e6) / 1e6;
        return rest;
      });
  }

  async getFreshness(accounts: readonly AccountRef[]): Promise<MetricsFreshness> {
    const allowed = new Set(accounts.map((a) => `${a.platform}|${a.accountId}`));
    let rollupsComputedAt: number | null = null;
    let observationsFetchedAt: number | null = null;
    for (const r of this.rollups.values()) {
      if (!allowed.has(`${r.platform}|${r.accountId}`)) continue;
      rollupsComputedAt = Math.max(rollupsComputedAt ?? -Infinity, Date.parse(r.computedAt));
    }
    for (const o of this.observations.values()) {
      if (!allowed.has(`${o.platform}|${o.accountId}`)) continue;
      observationsFetchedAt = Math.max(observationsFetchedAt ?? -Infinity, Date.parse(o.fetchedAt));
    }
    return {
      rollupsComputedAt: rollupsComputedAt === null ? null : new Date(rollupsComputedAt).toISOString(),
      observationsFetchedAt: observationsFetchedAt === null ? null : new Date(observationsFetchedAt).toISOString(),
    };
  }

  async changedSince(since?: string): Promise<ChangedWindow | null> {
    const after = since === undefined ? 0 : Number(since);
    let from: string | undefined;
    let to: string | undefined;
    let count = 0;
    for (const [k, seq] of this.inserted) {
      if (seq <= after) continue;
      const o = this.observations.get(k);
      if (!o) continue;
      count += 1;
      if (from === undefined || o.periodStart < from) from = o.periodStart;
      if (to === undefined || o.periodEnd > to) to = o.periodEnd;
    }
    if (count === 0 || from === undefined || to === undefined) return null;
    return { from, to, observationCount: count, watermark: String(this.seq) };
  }

  async ping(): Promise<void> {
    // Always reachable.
  }

  async close(): Promise<void> {
    // Nothing to release.
  }
}
