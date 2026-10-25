/**
 * MetricsStore port: normalised ad-platform observations with revisions, and
 * rollups derived from them.
 */

import type {
  MetricObservation,
  MetricObservationFilter,
  MetricRollup,
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
   * Recompute rollups for whole UTC buckets covering the window, from the
   * latest revision of each observation. Idempotent. Returns rollup rows written.
   */
  computeRollups(request: RollupRequest): Promise<number>;
  queryRollups(filter: RollupFilter): Promise<MetricRollup[]>;
  /** Throws if the backing service is unreachable. */
  ping(): Promise<void>;
  close(): Promise<void>;
}
