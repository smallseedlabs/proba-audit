/**
 * MetricsStore port: normalised ad-platform observations with revisions, and
 * rollups derived from them.
 *
 * Every method is scoped to one workspace (`workspaceId`, required, injected by trusted code):
 * the same platform account in two workspaces is two independent series, and nothing a caller
 * passes can read or replace another workspace's rows.
 */

import type {
  AccountRef,
  CampaignBinding,
  ChangedWindow,
  MetricsFreshness,
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
   * Upsert into `workspaceId` by key (platform, accountId, campaignId, adsetId, adId, granularity,
   * periodStart). An observation replaces the stored one when its revision is
   * greater than or equal to it; a lower revision is skipped as stale. If a
   * batch repeats a key, the highest revision wins.
   */
  upsertObservations(workspaceId: string, observations: MetricObservation[]): Promise<UpsertResult>;
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
   * The span of observations of `workspaceId` written (or rewritten) after `since` (an earlier
   * `watermark`; omit for everything), or null when there are none. Tells the
   * rollup process which window to recompute.
   */
  changedSince(workspaceId: string, since?: string): Promise<ChangedWindow | null>;
  /**
   * How recent the data of the given accounts is: the last rollup computation and the last
   * time an observation was fetched from the ad platform. Both null when there is no data.
   * An empty account list sees nothing.
   */
  getFreshness(workspaceId: string, accounts: readonly AccountRef[]): Promise<MetricsFreshness>;
  /**
   * Distinct ad accounts that have observations in `workspaceId`. Used as the analytics
   * scope when Ads (not a PlatformConnector) is the source of metrics. Never calls a provider.
   */
  listAccounts(workspaceId: string): Promise<AccountRef[]>;
  /**
   * Record workspace → probaCampaignId → provider campaign mappings from Ads audit events.
   * Latest write per (workspace, probaCampaignId) wins. Empty input is a no-op.
   */
  upsertCampaignBindings(bindings: readonly CampaignBinding[]): Promise<void>;
  /**
   * Translate campaign ids the caller already has (proba UUID and/or provider id) into the
   * provider campaign ids stored on observations. Unknown ids are returned unchanged so a
   * portal query by provider id still matches. Empty input stays empty.
   */
  resolveCampaignIds(workspaceId: string, ids: readonly string[]): Promise<string[]>;
  /** Throws if the backing service is unreachable. */
  ping(): Promise<void>;
  close(): Promise<void>;
}
