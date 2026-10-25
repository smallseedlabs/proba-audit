import {
  METRIC_QUERY_DEFAULT_LIMIT,
  METRIC_QUERY_MAX_LIMIT,
  alignWindow,
  bucketStart,
  type Clock,
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
    const groups = new Map<string, MetricRollup>();
    for (const o of this.observations.values()) {
      if (Date.parse(o.periodStart) < Date.parse(from) || Date.parse(o.periodStart) >= Date.parse(to)) continue;
      // An hourly rollup only summarises hourly observations.
      if (request.bucket === 'hour' && o.granularity !== 'hour') continue;
      const start = bucketStart(o.periodStart, request.bucket);
      const id = [o.platform, o.accountId, o.campaignId, o.adsetId ?? '', o.adId ?? '', o.granularity, start, o.currency].join('|');
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
          bucketStart: start,
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

  async ping(): Promise<void> {
    // Always reachable.
  }

  async close(): Promise<void> {
    // Nothing to release.
  }
}
