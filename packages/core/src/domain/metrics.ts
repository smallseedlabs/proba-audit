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
  /**
   * UTC instant at which the bucket starts. Hourly buckets start on the UTC hour.
   * Daily buckets start at local midnight in `timezone`, so for an account that
   * is not on UTC the instant is not a UTC midnight.
   */
  bucketStart: string;
  /** Daily buckets only: the account's IANA timezone the day was cut in (UTC when the observations carry none). */
  timezone?: string;
  /** Daily buckets only: the calendar date (YYYY-MM-DD) of the day in `timezone`. */
  bucketDate?: string;
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

export type AggregateDimension = 'platform' | 'account' | 'campaign' | 'bucket';

/** An ad account, as the pair that identifies it in the metrics tables. */
export interface AccountRef {
  platform: MetricPlatform;
  accountId: string;
}

/**
 * Sum rollups over [from, to), grouped by the chosen dimensions. Hourly: on
 * bucketStart. Daily: whole local days, selected by `bucketDate` against the UTC
 * calendar date of `from` (inclusive) and `to` (exclusive), so accounts in
 * different timezones line up on the same dates.
 * Rows are never summed across currencies or source granularities: those are
 * always part of the group.
 */
export interface RollupAggregateFilter {
  bucket: RollupBucket;
  from: string;
  to: string;
  groupBy: readonly AggregateDimension[];
  /** Only these accounts. Omit for all (internal use); an empty list matches nothing. */
  accounts?: readonly AccountRef[];
  campaignId?: string;
  /** Only rollups summed from observations of this granularity (avoids mixing hourly and daily sources). */
  sourceGranularity?: MetricGranularity;
  /** Default 1000, maximum 10000. */
  limit?: number;
}

export interface MetricAggregate {
  platform?: MetricPlatform;
  accountId?: string;
  campaignId?: string;
  /** Present when grouped by 'bucket': a UTC ISO instant for hourly rollups, a local YYYY-MM-DD date for daily ones. */
  bucket?: string;
  sourceGranularity: MetricGranularity;
  currency: string;
  /** Sums only; `reach` is not additive. */
  metrics: MetricRollup['metrics'];
  observationCount: number;
}

/** Window of observations written since a watermark, used to find what to roll up again. */
export interface ChangedWindow {
  /** Earliest periodStart among the changed observations. */
  from: string;
  /** Latest periodEnd among the changed observations. */
  to: string;
  observationCount: number;
  /** Pass as `since` next time. Never ahead of rows that may still be arriving. */
  watermark: string;
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

export interface ConnectorCampaign {
  campaignId: string;
  accountId: string;
  name: string;
  status: 'active' | 'paused' | 'ended';
}

export interface FetchWindow {
  /** Inclusive, UTC ISO 8601 with trailing Z. */
  from: string;
  /** Exclusive. */
  to: string;
  granularity: MetricGranularity;
}
