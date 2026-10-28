/**
 * Analytics read functions over the rollups: the first library-level read side.
 *
 * These back the portal and the controlled data tools (the brain never queries the
 * metrics tables itself). They are plain functions of an AnalyticsScope plus a strictly
 * validated query; wrap them in AuditedAnalyticsReader to record every read.
 *
 * The SCOPE is not an argument the caller composes: it says which ad accounts this
 * workspace may see, and it is produced by trusted code (the ScopeResolver given to
 * AuditedAnalyticsReader, from the authenticated session). A query can narrow inside
 * the scope (a campaign) but can never widen it.
 */

import { z } from 'zod';
import type {
  AccountRef,
  MetricAggregate,
  MetricGranularity,
} from '../domain/metrics.js';
import type { MetricsStore } from '../ports/metrics-store.js';

export interface AnalyticsScope {
  readonly workspaceId: string;
  /** The ad accounts that belong to the workspace. An empty list sees nothing. */
  readonly accounts: readonly AccountRef[];
  /**
   * Narrows the accounts to these campaigns (the campaigns of the goals one user owns). Omitted: every campaign of the
   * accounts. An empty list sees nothing. A query that names another campaign finds nothing.
   */
  readonly campaignIds?: readonly string[];
}

/** Caps that keep one read bounded. Exported so docs, UIs and tests agree with the code. */
export const ANALYTICS_LIMITS = {
  /** Longest range per granularity, in days (hourly: 14 days = 336 buckets, daily: 366 buckets). */
  maxRangeDays: { hour: 14, day: 366 },
  maxAccountsInScope: 500,
  maxCampaignsInScope: 500,
  maxCampaignIdLength: 128,
  /** Campaign rows returned by getMetricsSummary (highest spend first). */
  maxCampaignRows: 200,
} as const;

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

export class AnalyticsValidationError extends Error {
  readonly issues: { path: string; message: string }[];

  constructor(issues: { path: string; message: string }[]) {
    super(`invalid analytics query: ${issues.map((i) => `${i.path || '(root)'}: ${i.message}`).join('; ')}`);
    this.name = 'AnalyticsValidationError';
    this.issues = issues;
  }
}

const isoUtc = z.string().datetime({ message: 'must be an ISO 8601 UTC timestamp ending in Z' });
const campaignId = z
  .string()
  .max(ANALYTICS_LIMITS.maxCampaignIdLength)
  .regex(/^[A-Za-z0-9_.:-]+$/, 'letters, digits and _ . : - only');
const granularity = z.enum(['hour', 'day']);

const period = z.object({ from: isoUtc, to: isoUtc }).strict();

const summaryQuerySchema = z
  .object({ campaignId: campaignId.optional(), from: isoUtc, to: isoUtc, granularity })
  .strict();

const compareQuerySchema = z
  .object({
    campaignId: campaignId.optional(),
    granularity,
    current: period,
    /** Omit to compare with the period of the same length right before `current`. */
    previous: period.optional(),
  })
  .strict();

export type SummaryQuery = z.input<typeof summaryQuerySchema>;
export type CompareQuery = z.input<typeof compareQuerySchema>;

/** Sums for one currency, with the ratios people read first. Ratios are null when the divisor is 0. */
export interface MetricsTotals {
  currency: string;
  impressions: number;
  clicks: number;
  spend: number;
  conversions: number;
  videoViews?: number;
  revenue?: number;
  ctr: number | null;
  cpc: number | null;
  cpm: number | null;
  cpa: number | null;
  roas: number | null;
  observationCount: number;
}

export interface SeriesPoint extends MetricsTotals {
  /** UTC instant of the hour (hourly) or the local calendar date YYYY-MM-DD (daily). */
  bucket: string;
}

export interface CampaignTotals extends MetricsTotals {
  platform: string;
  accountId: string;
  campaignId: string;
}

export interface MetricsSummary {
  workspaceId: string;
  from: string;
  to: string;
  granularity: MetricGranularity;
  campaignId?: string;
  /** One entry per currency: amounts in different currencies are never added together. `reach` is not summed anywhere. */
  totals: MetricsTotals[];
  series: SeriesPoint[];
  /** Per campaign, highest spend first (omitted when the query names a campaign). */
  campaigns?: CampaignTotals[];
  /** True when more campaigns exist than `maxCampaignRows`. */
  campaignsTruncated?: boolean;
}

export interface Change {
  current: number;
  previous: number;
  change: number;
  /** Relative change in percent; null when the previous value is 0. */
  changePct: number | null;
}

export interface CurrencyComparison {
  currency: string;
  impressions: Change;
  clicks: Change;
  spend: Change;
  conversions: Change;
}

export interface PeriodComparison {
  workspaceId: string;
  granularity: MetricGranularity;
  campaignId?: string;
  current: { from: string; to: string; totals: MetricsTotals[] };
  previous: { from: string; to: string; totals: MetricsTotals[] };
  comparison: CurrencyComparison[];
}

const round = (n: number, dp = 6): number => Math.round(n * 10 ** dp) / 10 ** dp;
const ratio = (a: number, b: number, dp = 6): number | null => (b === 0 ? null : round(a / b, dp));

function totalsOf(currency: string, m: MetricAggregate['metrics'], observationCount: number): MetricsTotals {
  return {
    currency,
    impressions: m.impressions,
    clicks: m.clicks,
    spend: round(m.spend),
    conversions: round(m.conversions),
    ...(m.videoViews !== undefined ? { videoViews: m.videoViews } : {}),
    ...(m.revenue !== undefined ? { revenue: round(m.revenue) } : {}),
    ctr: ratio(m.clicks, m.impressions),
    cpc: ratio(m.spend, m.clicks),
    cpm: m.impressions === 0 ? null : round((m.spend / m.impressions) * 1000),
    cpa: ratio(m.spend, m.conversions),
    roas: m.revenue === undefined ? null : ratio(m.revenue, m.spend),
    observationCount,
  };
}

/** Merge aggregate rows of one currency (they differ only by source granularity). */
function mergeByCurrency(rows: readonly MetricAggregate[]): MetricsTotals[] {
  const byCurrency = new Map<string, { m: MetricAggregate['metrics']; n: number }>();
  for (const r of rows) {
    const acc = byCurrency.get(r.currency) ?? { m: { impressions: 0, clicks: 0, spend: 0, conversions: 0 }, n: 0 };
    acc.m.impressions += r.metrics.impressions;
    acc.m.clicks += r.metrics.clicks;
    acc.m.spend += r.metrics.spend;
    acc.m.conversions += r.metrics.conversions;
    if (r.metrics.videoViews !== undefined) acc.m.videoViews = (acc.m.videoViews ?? 0) + r.metrics.videoViews;
    if (r.metrics.revenue !== undefined) acc.m.revenue = (acc.m.revenue ?? 0) + r.metrics.revenue;
    acc.n += r.observationCount;
    byCurrency.set(r.currency, acc);
  }
  return [...byCurrency.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([c, v]) => totalsOf(c, v.m, v.n));
}

function change(current: number, previous: number): Change {
  return {
    current,
    previous,
    change: round(current - previous),
    changePct: previous === 0 ? null : round(((current - previous) / previous) * 100, 2),
  };
}

export interface MetricsAnalyticsOptions {
  /**
   * Which observation granularity the rollups are read from. It must be the granularity the
   * ingester writes (INGEST_GRANULARITY, hour by default); reading both would double count.
   */
  sourceGranularity?: MetricGranularity;
}

export class MetricsAnalytics {
  private readonly source: MetricGranularity;

  constructor(
    private readonly store: MetricsStore,
    options: MetricsAnalyticsOptions = {}
  ) {
    this.source = options.sourceGranularity ?? 'hour';
  }

  /** Totals, a time series and a per-campaign breakdown for [from, to). */
  async getMetricsSummary(scope: AnalyticsScope, query: SummaryQuery): Promise<MetricsSummary> {
    this.checkScope(scope);
    const q = this.parseSummary(query);
    const accounts = scope.accounts;
    const common = { workspaceId: scope.workspaceId, bucket: q.granularity, from: q.from, to: q.to, accounts, sourceGranularity: this.source, ...(q.campaignId ? { campaignId: q.campaignId } : {}), ...(scope.campaignIds ? { campaignIds: scope.campaignIds } : {}) } as const;

    const [total, series, byCampaign] = await Promise.all([
      this.store.aggregateRollups({ ...common, groupBy: [] }),
      this.store.aggregateRollups({ ...common, groupBy: ['bucket'], limit: ANALYTICS_LIMITS.maxRangeDays[q.granularity] * (q.granularity === 'hour' ? 24 : 1) * 4 }),
      q.campaignId
        ? Promise.resolve([] as MetricAggregate[])
        : this.store.aggregateRollups({ ...common, groupBy: ['platform', 'account', 'campaign'], limit: ANALYTICS_LIMITS.maxCampaignRows + 1 }),
    ]);

    const seriesPoints: SeriesPoint[] = [];
    const buckets = [...new Set(series.map((r) => r.bucket as string))].sort();
    for (const bucket of buckets) {
      for (const t of mergeByCurrency(series.filter((r) => r.bucket === bucket))) seriesPoints.push({ bucket, ...t });
    }

    const summary: MetricsSummary = {
      workspaceId: scope.workspaceId,
      from: q.from,
      to: q.to,
      granularity: q.granularity,
      ...(q.campaignId ? { campaignId: q.campaignId } : {}),
      totals: mergeByCurrency(total),
      series: seriesPoints,
    };
    if (!q.campaignId) {
      const campaigns = byCampaign
        .map((r) => ({ platform: r.platform as string, accountId: r.accountId as string, campaignId: r.campaignId as string, ...mergeByCurrency([r])[0] }))
        .sort((a, b) => b.spend - a.spend || a.campaignId.localeCompare(b.campaignId));
      summary.campaignsTruncated = campaigns.length > ANALYTICS_LIMITS.maxCampaignRows;
      summary.campaigns = campaigns.slice(0, ANALYTICS_LIMITS.maxCampaignRows);
    }
    return summary;
  }

  /** Two equal-length periods side by side, with the change per currency. */
  async comparePeriods(scope: AnalyticsScope, query: CompareQuery): Promise<PeriodComparison> {
    this.checkScope(scope);
    const q = this.parseCompare(query);
    const base = { granularity: q.granularity, ...(q.campaignId ? { campaignId: q.campaignId } : {}) };
    const [current, previous] = await Promise.all([
      this.getMetricsSummary(scope, { ...base, ...q.current }),
      this.getMetricsSummary(scope, { ...base, ...q.previous }),
    ]);
    const currencies = [...new Set([...current.totals, ...previous.totals].map((t) => t.currency))].sort();
    const pick = (list: MetricsTotals[], c: string): MetricsTotals | undefined => list.find((t) => t.currency === c);
    const comparison = currencies.map((currency) => {
      const a = pick(current.totals, currency);
      const b = pick(previous.totals, currency);
      return {
        currency,
        impressions: change(a?.impressions ?? 0, b?.impressions ?? 0),
        clicks: change(a?.clicks ?? 0, b?.clicks ?? 0),
        spend: change(a?.spend ?? 0, b?.spend ?? 0),
        conversions: change(a?.conversions ?? 0, b?.conversions ?? 0),
      };
    });
    return {
      workspaceId: scope.workspaceId,
      granularity: q.granularity,
      ...(q.campaignId ? { campaignId: q.campaignId } : {}),
      current: { from: q.current.from, to: q.current.to, totals: current.totals },
      previous: { from: q.previous.from, to: q.previous.to, totals: previous.totals },
      comparison,
    };
  }

  private checkScope(scope: AnalyticsScope): void {
    if (!scope.workspaceId) throw new AnalyticsValidationError([{ path: 'scope.workspaceId', message: 'required' }]);
    if (scope.campaignIds && scope.campaignIds.length > ANALYTICS_LIMITS.maxCampaignsInScope) {
      throw new AnalyticsValidationError([{ path: 'scope.campaignIds', message: `at most ${ANALYTICS_LIMITS.maxCampaignsInScope} campaigns` }]);
    }
    if (scope.accounts.length > ANALYTICS_LIMITS.maxAccountsInScope) {
      throw new AnalyticsValidationError([{ path: 'scope.accounts', message: `at most ${ANALYTICS_LIMITS.maxAccountsInScope} accounts` }]);
    }
  }

  private parseSummary(query: SummaryQuery): z.output<typeof summaryQuerySchema> {
    const parsed = summaryQuerySchema.safeParse(query);
    if (!parsed.success) throw fromZod(parsed.error);
    const issues = checkRange(parsed.data.from, parsed.data.to, parsed.data.granularity, '');
    if (issues.length > 0) throw new AnalyticsValidationError(issues);
    return parsed.data;
  }

  private parseCompare(query: CompareQuery): {
    campaignId?: string;
    granularity: MetricGranularity;
    current: { from: string; to: string };
    previous: { from: string; to: string };
  } {
    const parsed = compareQuerySchema.safeParse(query);
    if (!parsed.success) throw fromZod(parsed.error);
    const { granularity: g, current, campaignId: cid } = parsed.data;
    const issues = checkRange(current.from, current.to, g, 'current.');
    const length = Date.parse(current.to) - Date.parse(current.from);
    const previous = parsed.data.previous ?? {
      from: new Date(Date.parse(current.from) - length).toISOString(),
      to: current.from,
    };
    if (parsed.data.previous) {
      issues.push(...checkRange(previous.from, previous.to, g, 'previous.'));
      if (Date.parse(previous.to) - Date.parse(previous.from) !== length) {
        issues.push({ path: 'previous', message: 'must be as long as current' });
      }
    }
    if (issues.length > 0) throw new AnalyticsValidationError(issues);
    return { ...(cid ? { campaignId: cid } : {}), granularity: g, current, previous };
  }
}

function fromZod(error: z.ZodError): AnalyticsValidationError {
  return new AnalyticsValidationError(error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
}

/** Range rules: ordered, aligned to the bucket, and not longer than the cap for the granularity. */
function checkRange(from: string, to: string, g: MetricGranularity, prefix: string): { path: string; message: string }[] {
  const issues: { path: string; message: string }[] = [];
  const f = Date.parse(from);
  const t = Date.parse(to);
  if (!(f < t)) {
    issues.push({ path: `${prefix}to`, message: 'must be after from' });
    return issues;
  }
  const unit = g === 'hour' ? HOUR_MS : DAY_MS;
  if (f % unit !== 0) issues.push({ path: `${prefix}from`, message: g === 'hour' ? 'must be on the hour' : 'must be a UTC midnight (the date of a daily bucket)' });
  if (t % unit !== 0) issues.push({ path: `${prefix}to`, message: g === 'hour' ? 'must be on the hour' : 'must be a UTC midnight (the date of a daily bucket)' });
  const maxDays = ANALYTICS_LIMITS.maxRangeDays[g];
  if (t - f > maxDays * DAY_MS) issues.push({ path: `${prefix}to`, message: `range is longer than ${maxDays} days for ${g} granularity` });
  return issues;
}

export type { AccountRef };
