import type { ClickHouseClient } from '@clickhouse/client';
import {
  METRIC_QUERY_DEFAULT_LIMIT,
  METRIC_QUERY_MAX_LIMIT,
  alignWindow,
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

const TS = (name: string) => `parseDateTime64BestEffort({${name}:String}, 3, 'UTC')`;

interface ObservationRow {
  platform: MetricObservation['platform'];
  account_id: string;
  campaign_id: string;
  adset_id: string;
  ad_id: string;
  granularity: MetricObservation['granularity'];
  period_start: string;
  period_end: string;
  impressions: number;
  clicks: number;
  spend: number;
  conversions: number;
  reach: number | null;
  video_views: number | null;
  revenue: number | null;
  currency: string;
  timezone: string | null;
  fetched_at: string;
  revision: number;
  source_ref: string | null;
}

export function toObservationRow(o: MetricObservation): ObservationRow {
  return {
    platform: o.platform,
    account_id: o.accountId,
    campaign_id: o.campaignId,
    adset_id: o.adsetId ?? '',
    ad_id: o.adId ?? '',
    granularity: o.granularity,
    period_start: o.periodStart,
    period_end: o.periodEnd,
    impressions: o.metrics.impressions,
    clicks: o.metrics.clicks,
    spend: o.metrics.spend,
    conversions: o.metrics.conversions,
    reach: o.metrics.reach ?? null,
    video_views: o.metrics.videoViews ?? null,
    revenue: o.metrics.revenue ?? null,
    currency: o.currency,
    timezone: o.timezone ?? null,
    fetched_at: o.fetchedAt,
    revision: o.revision,
    source_ref: o.sourceRef ?? null,
  };
}

export function fromObservationRow(r: ObservationRow): MetricObservation {
  return {
    version: 1,
    platform: r.platform,
    accountId: r.account_id,
    campaignId: r.campaign_id,
    ...(r.adset_id !== '' ? { adsetId: r.adset_id } : {}),
    ...(r.ad_id !== '' ? { adId: r.ad_id } : {}),
    granularity: r.granularity,
    periodStart: r.period_start,
    periodEnd: r.period_end,
    metrics: {
      impressions: Number(r.impressions),
      clicks: Number(r.clicks),
      spend: Number(r.spend),
      conversions: Number(r.conversions),
      ...(r.reach !== null ? { reach: Number(r.reach) } : {}),
      ...(r.video_views !== null ? { videoViews: Number(r.video_views) } : {}),
      ...(r.revenue !== null ? { revenue: Number(r.revenue) } : {}),
    },
    currency: r.currency,
    ...(r.timezone !== null ? { timezone: r.timezone } : {}),
    fetchedAt: r.fetched_at,
    revision: Number(r.revision),
    ...(r.source_ref !== null ? { sourceRef: r.source_ref } : {}),
  };
}

interface RollupRow {
  platform: MetricRollup['platform'];
  account_id: string;
  campaign_id: string;
  adset_id: string;
  ad_id: string;
  source_granularity: MetricRollup['sourceGranularity'];
  bucket_start: string;
  currency: string;
  impressions: number;
  clicks: number;
  spend: number;
  conversions: number;
  video_views: number | null;
  revenue: number | null;
  observation_count: number;
  computed_at: string;
}

function fromRollupRow(r: RollupRow, bucket: MetricRollup['bucket']): MetricRollup {
  return {
    platform: r.platform,
    accountId: r.account_id,
    campaignId: r.campaign_id,
    ...(r.adset_id !== '' ? { adsetId: r.adset_id } : {}),
    ...(r.ad_id !== '' ? { adId: r.ad_id } : {}),
    sourceGranularity: r.source_granularity,
    bucket,
    bucketStart: r.bucket_start,
    currency: r.currency,
    metrics: {
      impressions: Number(r.impressions),
      clicks: Number(r.clicks),
      spend: Number(r.spend),
      conversions: Number(r.conversions),
      ...(r.video_views !== null ? { videoViews: Number(r.video_views) } : {}),
      ...(r.revenue !== null ? { revenue: Number(r.revenue) } : {}),
    },
    observationCount: Number(r.observation_count),
    computedAt: r.computed_at,
  };
}

interface Where {
  sql: string;
  params: Record<string, unknown>;
}

function buildWhere(
  f: {
    platform?: string;
    accountId?: string;
    campaignId?: string;
    adsetId?: string;
    adId?: string;
    from?: string;
    to?: string;
  },
  granularityColumn: string,
  granularity: string | undefined,
  timeColumn: string
): Where {
  const clauses: string[] = [];
  const params: Record<string, unknown> = {};
  const eq = (column: string, name: string, value: string | undefined): void => {
    if (value === undefined) return;
    clauses.push(`${column} = {${name}:String}`);
    params[name] = value;
  };
  eq('platform', 'platform', f.platform);
  eq('account_id', 'accountId', f.accountId);
  eq('campaign_id', 'campaignId', f.campaignId);
  eq('adset_id', 'adsetId', f.adsetId);
  eq('ad_id', 'adId', f.adId);
  eq(granularityColumn, 'granularity', granularity);
  if (f.from !== undefined) {
    clauses.push(`${timeColumn} >= ${TS('from')}`);
    params.from = f.from;
  }
  if (f.to !== undefined) {
    clauses.push(`${timeColumn} < ${TS('to')}`);
    params.to = f.to;
  }
  return { sql: clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '', params };
}

export interface ClickHouseMetricsStoreOptions {
  client: ClickHouseClient;
  clock?: Clock;
  ownsClient?: boolean;
}

const KEY_COLUMNS = 'platform, account_id, campaign_id, adset_id, ad_id, granularity, period_start';

/**
 * MetricsStore on ClickHouse. Observations live in a ReplacingMergeTree keyed
 * on revision (always read with FINAL); rollups are recomputed from the latest
 * revisions and replace earlier rows.
 */
export class ClickHouseMetricsStore implements MetricsStore {
  private readonly client: ClickHouseClient;
  private readonly clock: Clock;
  private readonly ownsClient: boolean;

  constructor(options: ClickHouseMetricsStoreOptions) {
    this.client = options.client;
    this.clock = options.clock ?? new SystemClock();
    this.ownsClient = options.ownsClient ?? false;
  }

  async upsertObservations(observations: MetricObservation[]): Promise<UpsertResult> {
    if (observations.length === 0) return { written: 0, skippedStale: 0 };

    // Highest revision per key within the batch wins.
    const batch = new Map<string, MetricObservation>();
    for (const o of observations) {
      const k = this.key(o);
      const prev = batch.get(k);
      if (!prev || o.revision >= prev.revision) batch.set(k, o);
    }
    const candidates = [...batch.values()];

    // Revisions already stored for the campaigns and period span in this batch.
    const times = candidates.map((o) => Date.parse(o.periodStart));
    const triples = new Map(candidates.map((o) => [`${o.platform}|${o.accountId}|${o.campaignId}`, o]));
    const stored = await this.rows<{ platform: string; account_id: string; campaign_id: string; adset_id: string; ad_id: string; granularity: string; period_start: string; revision: number }>(
      `SELECT ${KEY_COLUMNS}, revision FROM metric_observations FINAL
       WHERE has(arrayZip({p:Array(String)}, {a:Array(String)}, {c:Array(String)}), (toString(platform), account_id, campaign_id))
         AND period_start >= ${TS('min')} AND period_start <= ${TS('max')}`,
      {
        p: [...triples.values()].map((o) => o.platform),
        a: [...triples.values()].map((o) => o.accountId),
        c: [...triples.values()].map((o) => o.campaignId),
        min: new Date(Math.min(...times)).toISOString(),
        max: new Date(Math.max(...times)).toISOString(),
      }
    );
    const storedRevision = new Map(
      stored.map((s) => [
        [s.platform, s.account_id, s.campaign_id, s.adset_id, s.ad_id, s.granularity, new Date(s.period_start).toISOString()].join('|'),
        Number(s.revision),
      ])
    );

    const toWrite = candidates.filter((o) => {
      const current = storedRevision.get(this.key(o));
      return current === undefined || current <= o.revision;
    });
    if (toWrite.length > 0) {
      await this.client.insert({ table: 'metric_observations', values: toWrite.map(toObservationRow), format: 'JSONEachRow' });
    }
    return { written: toWrite.length, skippedStale: candidates.length - toWrite.length };
  }

  async queryObservations(filter: MetricObservationFilter): Promise<MetricObservation[]> {
    const where = buildWhere(filter, 'granularity', filter.granularity, 'period_start');
    const limit = Math.min(filter.limit ?? METRIC_QUERY_DEFAULT_LIMIT, METRIC_QUERY_MAX_LIMIT);
    const rows = await this.rows<ObservationRow>(
      `SELECT * EXCEPT inserted_at FROM metric_observations FINAL ${where.sql}
       ORDER BY period_start ASC, platform, account_id, campaign_id, adset_id, ad_id, granularity
       LIMIT {limit:UInt32}`,
      { ...where.params, limit }
    );
    return rows.map(fromObservationRow);
  }

  async computeRollups(request: RollupRequest): Promise<number> {
    const { from, to } = alignWindow(request.from, request.to, request.bucket);
    const table = request.bucket === 'hour' ? 'metric_rollups_hourly' : 'metric_rollups_daily';
    const start = request.bucket === 'hour' ? "toStartOfHour(period_start, 'UTC')" : "toStartOfDay(period_start, 'UTC')";
    // An hourly rollup only summarises hourly observations.
    const granularityFilter = request.bucket === 'hour' ? "AND granularity = 'hour'" : '';
    const params = { from, to, computedAt: this.clock.isoNow() };

    const select = `
      SELECT platform, account_id, campaign_id, adset_id, ad_id,
             granularity AS source_granularity,
             toDateTime64(${start}, 3, 'UTC') AS bucket_start,
             currency,
             sum(impressions) AS impressions,
             sum(clicks) AS clicks,
             sum(spend) AS spend,
             sum(conversions) AS conversions,
             sum(video_views) AS video_views,
             sum(revenue) AS revenue,
             toUInt32(count()) AS observation_count,
             ${TS('computedAt')} AS computed_at
      FROM metric_observations FINAL
      WHERE period_start >= ${TS('from')} AND period_start < ${TS('to')} ${granularityFilter}
      GROUP BY platform, account_id, campaign_id, adset_id, ad_id, source_granularity, bucket_start, currency`;

    const [{ n }] = await this.rows<{ n: number }>(`SELECT count() AS n FROM (${select})`, params);
    if (Number(n) > 0) {
      await this.client.command({
        query: `INSERT INTO ${table}
                (platform, account_id, campaign_id, adset_id, ad_id, source_granularity, bucket_start, currency,
                 impressions, clicks, spend, conversions, video_views, revenue, observation_count, computed_at)
                ${select}`,
        query_params: params,
      });
    }
    return Number(n);
  }

  async queryRollups(filter: RollupFilter): Promise<MetricRollup[]> {
    const table = filter.bucket === 'hour' ? 'metric_rollups_hourly' : 'metric_rollups_daily';
    const where = buildWhere(filter, 'source_granularity', filter.sourceGranularity, 'bucket_start');
    const limit = Math.min(filter.limit ?? METRIC_QUERY_DEFAULT_LIMIT, METRIC_QUERY_MAX_LIMIT);
    const rows = await this.rows<RollupRow>(
      `SELECT * FROM ${table} FINAL ${where.sql}
       ORDER BY bucket_start ASC, platform, account_id, campaign_id, adset_id, ad_id, source_granularity
       LIMIT {limit:UInt32}`,
      { ...where.params, limit }
    );
    return rows.map((r) => fromRollupRow(r, filter.bucket));
  }

  async ping(): Promise<void> {
    const result = await this.client.ping();
    if (!result.success) throw result.error;
  }

  async close(): Promise<void> {
    if (this.ownsClient) await this.client.close();
  }

  private key(o: MetricObservation): string {
    return [o.platform, o.accountId, o.campaignId, o.adsetId ?? '', o.adId ?? '', o.granularity, o.periodStart].join('|');
  }

  private async rows<T>(query: string, params?: Record<string, unknown>): Promise<T[]> {
    const rs = await this.client.query({ query, query_params: params, format: 'JSONEachRow' });
    return rs.json<T>();
  }
}
