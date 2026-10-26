/**
 * MetricsStore port: normalised ad-platform observations with revisions, and
 * rollups derived from them.
 */

import type {
  ChangedWindow,
  MetricAggregate,
  MetricObservation,
  MetricObservationFilter,
  MetricRollup,
  RollupAggregateFilter,
  RollupFilter,
  RollupRequest,
  UpsertResult,
} from '../domain/metrics.js';

export interface MetricsStore {
  /**
   * Upsert by key (platform, accountId, campaignId, adsetId, adId, granularity,
   * periodStart). An observation replaces the stored one when its revision is
   * greater than or equal to it; a lower revision is skipped as stale. If a
   * batch repeats a key, the highest revision wins.
   */
  upsertObservations(observations: MetricObservation[]): Promise<UpsertResult>;
  /** Latest revision per key, ordered by periodStart ascending. */
  queryObservations(filter: MetricObservationFilter): Promise<MetricObservation[]>;
  /**
   * Recompute rollups for whole buckets covering the window, from the latest
   * revision of each observation. Idempotent: a restated observation replaces its
   * earlier revision in the sums, never adds to it. Hourly buckets are UTC hours.
   * Daily buckets are local days in each observation's `timezone` (UTC when it has
   * none), so a daily bucket starts at local midnight of the account. Returns the
   * number of rollup rows written.
   */
  computeRollups(request: RollupRequest): Promise<number>;
  queryRollups(filter: RollupFilter): Promise<MetricRollup[]>;
  /**
   * Sum stored rollups over a range, grouped by platform / account / campaign /
   * bucket. Never mixes currencies or source granularities. `reach` is not summed.
   */
  aggregateRollups(filter: RollupAggregateFilter): Promise<MetricAggregate[]>;
  /**
   * The span of observations written (or rewritten) after `since` (an earlier
   * `watermark`; omit for everything), or null when there are none. Tells the
   * rollup process which window to recompute.
   */
  changedSince(since?: string): Promise<ChangedWindow | null>;
  /** Throws if the backing service is unreachable. */
  ping(): Promise<void>;
  close(): Promise<void>;
}
