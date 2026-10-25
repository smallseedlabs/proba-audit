/**
 * Metrics domain types used by the MetricsStore and PlatformConnector ports.
 */

import type {
  MetricGranularity,
  MetricPlatform,
} from '@smallseedlabs/proba-protocol/audit';

export type {
  MetricObservation,
  MetricPlatform,
  MetricGranularity,
  MetricValues,
} from '@smallseedlabs/proba-protocol/audit';

export interface MetricObservationFilter {
  platform?: MetricPlatform;
  accountId?: string;
  campaignId?: string;
  adsetId?: string;
  adId?: string;
  granularity?: MetricGranularity;
  /** On periodStart, inclusive. UTC ISO 8601 with trailing Z. */
  from?: string;
  /** On periodStart, exclusive. */
  to?: string;
  /** Default 1000, maximum 10000. */
  limit?: number;
}

export const METRIC_QUERY_DEFAULT_LIMIT = 1000;
export const METRIC_QUERY_MAX_LIMIT = 10000;

export interface UpsertResult {
  /** Observations written (new key, or revision >= the stored revision). */
  written: number;
  /** Observations skipped because a higher revision is already stored. */
  skippedStale: number;
}

export type RollupBucket = 'hour' | 'day';

/** Window of observations (by periodStart) to roll up. Aligned outwards to whole buckets. */
export interface RollupRequest {
  bucket: RollupBucket;
  from: string;
  to: string;
}

export interface MetricRollup {
  platform: MetricPlatform;
  accountId: string;
  campaignId: string;
  adsetId?: string;
  adId?: string;
  /** Granularity of the observations that were summed. */
  sourceGranularity: MetricGranularity;
  bucket: RollupBucket;
  /** UTC ISO start of the bucket. */
  bucketStart: string;
  currency: string;
  /** Sums only. `reach` is deliberately absent: unique reach is not additive. */
  metrics: {
    impressions: number;
    clicks: number;
    spend: number;
    conversions: number;
    videoViews?: number;
    revenue?: number;
  };
  observationCount: number;
  computedAt: string;
}

export interface RollupFilter {
  bucket: RollupBucket;
  platform?: MetricPlatform;
  accountId?: string;
  campaignId?: string;
  adsetId?: string;
  adId?: string;
  sourceGranularity?: MetricGranularity;
  from?: string;
  to?: string;
  limit?: number;
}

/** Account an ad platform connector fetches for. Never carries secrets inline. */
export interface ConnectorAccount {
  accountId: string;
  workspaceId?: string;
  /** Opaque reference to credentials held elsewhere (for example a secret name). */
  credentialsRef?: string;
  /** IANA reporting timezone of the ad account. */
  timezone?: string;
  currency?: string;
}

export interface FetchWindow {
  /** Inclusive, UTC ISO 8601 with trailing Z. */
  from: string;
  /** Exclusive. */
  to: string;
  granularity: MetricGranularity;
}
