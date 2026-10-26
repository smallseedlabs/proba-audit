/**
 * StubPlatformConnector: the DEVELOPMENT DATA SOURCE for ad-platform analytics.
 *
 * The per-platform analytics libraries (Meta, Google, Reddit, X, Microsoft) are
 * built separately. Until one is plugged in, the metrics ingester runs against
 * this connector, which implements the same PlatformConnector port and returns
 * deterministic, realistic-looking hourly and daily numbers for a few synthetic
 * accounts, campaigns, ad sets and ads. Swapping in a real library is a config
 * change (PLATFORM_CONNECTORS=meta:meta-lib), not a code change.
 *
 * Safety: this connector must never feed production dashboards.
 * - It refuses to be constructed when NODE_ENV=production unless
 *   ALLOW_STUB_CONNECTOR=true is set explicitly.
 * - Every observation it returns has a `sourceRef` starting with `stub:`, so its
 *   rows can always be told apart from real data (and deleted by that marker).
 *
 * Determinism: all numbers are pure functions of (seed, ad, period, time), so
 * tests are repeatable. The only inputs are the injected clock and the seed.
 *
 * Restatements: a period that has ended is restated every
 * `restateEveryMinutes` after its end, `restateRevisions` times (revision 1, 2,
 * ...), changing conversions, revenue, spend and delivery slightly, like late
 * attributed conversions. The revision at a given time is a pure function of that
 * time, so advancing the clock is how tests trigger restatements.
 */

import {
  ConnectorAuthError,
  ConnectorRequestError,
  RateLimitedError,
  TransientConnectorError,
  dayBucket,
  localParts,
  nextDayStart,
  type Clock,
  type ConnectorAccount,
  type ConnectorCampaign,
  type ConnectorCapabilities,
  type FetchPage,
  type FetchRequest,
  type MetricGranularity,
  type MetricObservation,
  type MetricPlatform,
  type PlatformConnector,
} from '@smallseedlabs/proba-audit-core';

export const STUB_ADAPTER_NAME = 'stub';
/** Prefix of every stub observation's sourceRef. */
export const STUB_SOURCE_REF_PREFIX = 'stub:';

const HOUR_MS = 3_600_000;
const MAX_LOOKBACK_DAYS = 30;

export class StubConnectorNotAllowedError extends Error {
  constructor() {
    super(
      'The stub platform connector is a development data source and is disabled in production. ' +
        'Set PLATFORM_CONNECTORS to a real adapter, or set ALLOW_STUB_CONNECTOR=true to run it deliberately.'
    );
    this.name = 'StubConnectorNotAllowedError';
  }
}

/** Throws unless the stub may run: anywhere but production, or production with the explicit opt-in. */
export function assertStubConnectorAllowed(nodeEnv: string | undefined, allowStub: boolean): void {
  if (nodeEnv === 'production' && !allowStub) throw new StubConnectorNotAllowedError();
}

/** A fault to inject into the next connector call(s). */
export type StubFault =
  | { kind: 'rate_limit'; retryAfterMs?: number }
  | { kind: 'transient' }
  | { kind: 'auth' }
  | { kind: 'request' };

/** How to corrupt observations (to exercise validation and quarantine). */
export type StubCorruption = 'negative_spend' | 'wrong_platform' | 'bad_period' | 'missing_currency';

export interface StubAccountSpec {
  accountId: string;
  name: string;
  timezone: string;
  currency: string;
  campaigns: number;
}

export interface StubConnectorOptions {
  platform: MetricPlatform;
  clock: Clock;
  seed?: string;
  restateEveryMinutes?: number;
  restateRevisions?: number;
  /** Probability (0..1) that a call fails with a transient error (deterministic per call number). */
  failureRate?: number;
  /** Default: process.env.NODE_ENV. */
  nodeEnv?: string;
  /** Default: process.env.ALLOW_STUB_CONNECTOR === 'true'. */
  allowStub?: boolean;
  accounts?: StubAccountSpec[];
}

interface AdSpec {
  accountId: string;
  campaignId: string;
  adsetId: string;
  adId: string;
  baseImpressions: number;
  ctr: number;
  cpc: number;
  cvr: number;
  aov: number;
  video: boolean;
  reachRatio: number;
}

/** Whole-hour UTC offsets only, so day boundaries fall on the stub's hourly grid. */
const DEFAULT_ACCOUNTS = (platform: string): StubAccountSpec[] => [
  { accountId: `stub_${platform}_acct_1`, name: 'Northwind (UK)', timezone: 'Europe/London', currency: 'GBP', campaigns: 2 },
  { accountId: `stub_${platform}_acct_2`, name: 'Contoso (US East)', timezone: 'America/New_York', currency: 'USD', campaigns: 3 },
  { accountId: `stub_${platform}_acct_3`, name: 'Fabrikam (AU)', timezone: 'Australia/Sydney', currency: 'AUD', campaigns: 2 },
];

const CAMPAIGN_NAMES = ['Spring launch', 'Always-on prospecting', 'Retargeting', 'Brand lift', 'Holiday push'];

/** 32-bit FNV-1a with a murmur-style finaliser: uniform enough, fast, deterministic. */
function hash32(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** Deterministic number in [0, 1) from the parts. */
function unit(...parts: (string | number)[]): number {
  return hash32(parts.join('|')) / 0x1_0000_0000;
}

const round = (n: number, digits: number): number => {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
};

interface Raw {
  impressions: number;
  clicks: number;
  spend: number;
  conversions: number;
  reach: number;
  videoViews?: number;
  revenue: number;
}

export class StubPlatformConnector implements PlatformConnector {
  readonly adapter = STUB_ADAPTER_NAME;
  readonly platform: MetricPlatform;

  private readonly clock: Clock;
  private readonly seed: string;
  private readonly restateEveryMs: number;
  private readonly restateRevisions: number;
  private readonly failureRate: number;
  private readonly accountSpecs: StubAccountSpec[];
  private readonly adsByAccount = new Map<string, AdSpec[]>();
  private readonly faults: StubFault[] = [];
  private corruption: { count: number; how: StubCorruption } | undefined;
  private calls = 0;

  constructor(options: StubConnectorOptions) {
    assertStubConnectorAllowed(options.nodeEnv ?? process.env.NODE_ENV, options.allowStub ?? process.env.ALLOW_STUB_CONNECTOR === 'true');
    this.platform = options.platform;
    this.clock = options.clock;
    this.seed = options.seed ?? 'proba-dev';
    this.restateEveryMs = (options.restateEveryMinutes ?? 30) * 60_000;
    this.restateRevisions = options.restateRevisions ?? 2;
    this.failureRate = options.failureRate ?? 0;
    this.accountSpecs = options.accounts ?? DEFAULT_ACCOUNTS(options.platform);
    for (const spec of this.accountSpecs) this.adsByAccount.set(spec.accountId, this.buildAds(spec));
  }

  // ---- test controls -------------------------------------------------------

  /** Make the next `times` connector calls fail with `fault`. */
  injectFault(fault: StubFault, times = 1): void {
    for (let i = 0; i < times; i += 1) this.faults.push(fault);
  }

  /** Corrupt the first `count` observations of the next page that has any. */
  corruptNext(how: StubCorruption, count = 1): void {
    this.corruption = { how, count };
  }

  /** Number of connector calls made (list and fetch). */
  get callCount(): number {
    return this.calls;
  }

  // ---- PlatformConnector ---------------------------------------------------

  capabilities(): ConnectorCapabilities {
    return {
      platform: this.platform,
      granularities: ['hour', 'day'],
      maxLookbackDays: MAX_LOOKBACK_DAYS,
      supportsRestatements: this.restateRevisions > 0,
      restatementWindowHours: Math.ceil((this.restateRevisions * this.restateEveryMs) / HOUR_MS) + 1,
      supportsCursor: true,
      maxPageSize: 1000,
    };
  }

  async listAccounts(): Promise<ConnectorAccount[]> {
    this.beforeCall();
    return this.accountSpecs.map((s) => ({
      accountId: s.accountId,
      timezone: s.timezone,
      currency: s.currency,
      credentialsRef: 'stub:none',
    }));
  }

  async listCampaigns(account: ConnectorAccount): Promise<ConnectorCampaign[]> {
    this.beforeCall();
    const ads = this.adsOf(account.accountId);
    const ids = [...new Set(ads.map((a) => a.campaignId))];
    return ids.map((campaignId, i) => ({
      campaignId,
      accountId: account.accountId,
      name: CAMPAIGN_NAMES[i % CAMPAIGN_NAMES.length],
      status: 'active' as const,
    }));
  }

  async fetchObservations(account: ConnectorAccount, request: FetchRequest): Promise<FetchPage> {
    this.beforeCall();
    const spec = this.accountSpecs.find((s) => s.accountId === account.accountId);
    if (!spec) throw new ConnectorRequestError(`unknown account ${account.accountId}`);
    const { window } = request;
    if (!['hour', 'day'].includes(window.granularity)) throw new ConnectorRequestError('unsupported granularity');

    const { asOf, offset } = this.parsePageToken(request.pageToken);
    const since = request.cursor === undefined ? undefined : this.parseCursor(request.cursor);
    const asOfMs = Date.parse(asOf);

    const all = this.observationsFor(spec, window.granularity, Date.parse(window.from), Date.parse(window.to), asOfMs, since);
    const size = Math.max(1, Math.min(request.pageSize ?? 500, this.capabilities().maxPageSize));
    const page = all.slice(offset, offset + size);
    const corrupted = this.applyCorruption(page);
    const more = offset + size < all.length;
    return {
      observations: corrupted,
      ...(more ? { nextPageToken: `${asOf}#${offset + size}` } : {}),
      nextCursor: `stub:${asOf}`,
    };
  }

  // ---- internals -----------------------------------------------------------

  private beforeCall(): void {
    this.calls += 1;
    const fault = this.faults.shift();
    if (fault) {
      switch (fault.kind) {
        case 'rate_limit':
          throw new RateLimitedError('stub: rate limited', fault.retryAfterMs);
        case 'transient':
          throw new TransientConnectorError('stub: temporary error');
        case 'auth':
          throw new ConnectorAuthError('stub: credentials rejected');
        case 'request':
          throw new ConnectorRequestError('stub: bad request');
      }
    }
    if (this.failureRate > 0 && unit(this.seed, 'fault', this.platform, this.calls) < this.failureRate) {
      // One in five injected failures is a rate limit with a hint, the rest are transient.
      if (hash32(`${this.seed}|kind|${this.calls}`) % 5 === 0) throw new RateLimitedError('stub: rate limited', 500);
      throw new TransientConnectorError('stub: temporary error');
    }
  }

  private parseCursor(cursor: string): number {
    const m = /^stub:(.+)$/.exec(cursor);
    const ms = m ? Date.parse(m[1]) : NaN;
    if (Number.isNaN(ms)) throw new ConnectorRequestError('invalid cursor');
    return ms;
  }

  private parsePageToken(token: string | undefined): { asOf: string; offset: number } {
    if (token === undefined) return { asOf: this.clock.isoNow(), offset: 0 };
    const m = /^(.+)#(\d+)$/.exec(token);
    if (!m || Number.isNaN(Date.parse(m[1]))) throw new ConnectorRequestError('invalid page token');
    return { asOf: m[1], offset: Number(m[2]) };
  }

  private adsOf(accountId: string): AdSpec[] {
    const ads = this.adsByAccount.get(accountId);
    if (!ads) throw new ConnectorRequestError(`unknown account ${accountId}`);
    return ads;
  }

  private buildAds(spec: StubAccountSpec): AdSpec[] {
    const ads: AdSpec[] = [];
    const p = this.platform;
    for (let c = 1; c <= spec.campaigns; c += 1) {
      const campaignId = `stub_${p}_cmp_${spec.accountId.slice(-1)}${c}`;
      for (let s = 1; s <= 2; s += 1) {
        const adsetId = `${campaignId}_as${s}`;
        for (let a = 1; a <= 2; a += 1) {
          const adId = `${adsetId}_ad${a}`;
          const k = [this.seed, adId];
          ads.push({
            accountId: spec.accountId,
            campaignId,
            adsetId,
            adId,
            baseImpressions: Math.round(300 + unit(...k, 'impr') * 2400),
            ctr: 0.008 + unit(...k, 'ctr') * 0.022,
            cpc: 0.2 + unit(...k, 'cpc') * 1.3,
            cvr: 0.005 + unit(...k, 'cvr') * 0.045,
            aov: 20 + unit(...k, 'aov') * 60,
            video: unit(...k, 'video') < 0.4,
            reachRatio: 0.7 + unit(...k, 'reach') * 0.2,
          });
        }
      }
    }
    return ads;
  }

  /** Revision of a period that ended at `endMs`, as of `atMs`. */
  private revisionAt(endMs: number, atMs: number): number {
    if (atMs < endMs || this.restateRevisions === 0) return 0;
    return Math.min(this.restateRevisions, Math.floor((atMs - endMs) / this.restateEveryMs));
  }

  /** Numbers of one ad for one whole hour at a revision. */
  private hourly(ad: AdSpec, tz: string, startMs: number, revision: number): Raw {
    const k = [this.seed, ad.adId, startMs];
    const local = localParts(startMs, tz);
    const dow = new Date(Date.UTC(local.y, local.m - 1, local.d)).getUTCDay();
    // Low overnight, peaking in the local evening; a little quieter at weekends.
    const diurnal = 0.25 + 0.75 * (0.5 - 0.5 * Math.cos((2 * Math.PI * (local.h - 8)) / 24));
    const week = dow === 0 || dow === 6 ? 0.85 : 1;
    const noise = 0.85 + 0.3 * unit(...k, 'noise');
    const impressions0 = ad.baseImpressions * diurnal * week * noise;
    const clicks0 = impressions0 * ad.ctr * (0.85 + 0.3 * unit(...k, 'clk'));
    const conversions0 = clicks0 * ad.cvr * (0.7 + 0.6 * unit(...k, 'cv'));
    const spend0 = clicks0 * ad.cpc * (0.9 + 0.2 * unit(...k, 'sp'));

    // Restatements: late conversions mostly add up; delivery and spend move a little.
    const r = revision;
    const rev = (name: string): number => unit(...k, 'rev', name, r);
    const impressions = Math.round(impressions0 * (1 + r * 0.01 * rev('i')));
    const clicks = Math.min(impressions, Math.round(clicks0 * (1 + r * 0.01 * rev('c'))));
    const conversions = round(conversions0 * (1 + r * (0.04 + 0.08 * rev('v'))), 2);
    const spend = round(spend0 * (1 + r * (0.03 * rev('s') - 0.005)), 4);
    return {
      impressions,
      clicks,
      spend,
      conversions,
      reach: Math.round(impressions * ad.reachRatio),
      ...(ad.video ? { videoViews: Math.round(impressions * (0.3 + 0.1 * unit(...k, 'vv'))) } : {}),
      revenue: round(conversions * ad.aov, 2),
    };
  }

  private observationsFor(
    spec: StubAccountSpec,
    granularity: MetricGranularity,
    fromMs: number,
    toMs: number,
    asOfMs: number,
    sinceMs: number | undefined
  ): MetricObservation[] {
    const earliest = asOfMs - MAX_LOOKBACK_DAYS * 24 * HOUR_MS;
    const limitMs = Math.min(toMs, asOfMs);
    const periods: { start: number; end: number }[] = [];
    if (granularity === 'hour') {
      for (let s = Math.ceil(Math.max(fromMs, earliest) / HOUR_MS) * HOUR_MS; s + HOUR_MS <= limitMs; s += HOUR_MS) {
        periods.push({ start: s, end: s + HOUR_MS });
      }
    } else {
      let s = Date.parse(dayBucket(new Date(Math.max(fromMs, earliest)).toISOString(), spec.timezone).start);
      if (s < Math.max(fromMs, earliest)) s = Date.parse(nextDayStart(new Date(s).toISOString(), spec.timezone));
      for (;;) {
        const e = Date.parse(nextDayStart(new Date(s).toISOString(), spec.timezone));
        if (e > limitMs) break;
        periods.push({ start: s, end: e });
        s = e;
      }
    }

    const out: MetricObservation[] = [];
    for (const period of periods) {
      const revisionNow = this.revisionOfPeriod(granularity, period, asOfMs);
      if (sinceMs !== undefined) {
        const isNew = period.end > sinceMs;
        if (!isNew && revisionNow <= this.revisionOfPeriod(granularity, period, sinceMs)) continue;
      }
      for (const ad of this.adsOf(spec.accountId)) {
        out.push(this.observation(spec, ad, granularity, period, revisionNow, asOfMs));
      }
    }
    return out.sort(
      (a, b) =>
        a.periodStart.localeCompare(b.periodStart) ||
        a.campaignId.localeCompare(b.campaignId) ||
        (a.adId ?? '').localeCompare(b.adId ?? '')
    );
  }

  /**
   * Hourly: restated `restateEveryMinutes` after the hour ends. Daily: the number
   * of hourly restatements inside the day since the day ended, so it starts at 0
   * the moment the day is complete and rises whenever its numbers change.
   */
  private revisionOfPeriod(granularity: MetricGranularity, period: { start: number; end: number }, atMs: number): number {
    if (granularity === 'hour') return this.revisionAt(period.end, atMs);
    let at = 0;
    let atEnd = 0;
    for (let h = period.start; h < period.end; h += HOUR_MS) {
      at += this.revisionAt(h + HOUR_MS, atMs);
      atEnd += this.revisionAt(h + HOUR_MS, period.end);
    }
    return Math.max(0, at - atEnd);
  }

  private observation(
    spec: StubAccountSpec,
    ad: AdSpec,
    granularity: MetricGranularity,
    period: { start: number; end: number },
    revision: number,
    asOfMs: number
  ): MetricObservation {
    let raw: Raw;
    if (granularity === 'hour') {
      raw = this.hourly(ad, spec.timezone, period.start, revision);
    } else {
      // A day is the sum of its hours, each at the revision it has as of now.
      const sum: Raw = { impressions: 0, clicks: 0, spend: 0, conversions: 0, reach: 0, revenue: 0 };
      let video: number | undefined;
      for (let h = period.start; h < period.end; h += HOUR_MS) {
        const hr = this.hourly(ad, spec.timezone, h, this.revisionAt(h + HOUR_MS, asOfMs));
        sum.impressions += hr.impressions;
        sum.clicks += hr.clicks;
        sum.spend += hr.spend;
        sum.conversions += hr.conversions;
        sum.reach += hr.reach;
        sum.revenue += hr.revenue;
        if (hr.videoViews !== undefined) video = (video ?? 0) + hr.videoViews;
      }
      raw = { ...sum, spend: round(sum.spend, 4), conversions: round(sum.conversions, 2), revenue: round(sum.revenue, 2), reach: Math.round(sum.reach * 0.55), ...(video !== undefined ? { videoViews: video } : {}) };
    }
    const periodStart = new Date(period.start).toISOString();
    return {
      version: 1,
      platform: this.platform,
      accountId: spec.accountId,
      campaignId: ad.campaignId,
      adsetId: ad.adsetId,
      adId: ad.adId,
      granularity,
      periodStart,
      periodEnd: new Date(period.end).toISOString(),
      metrics: {
        impressions: raw.impressions,
        clicks: raw.clicks,
        spend: raw.spend,
        conversions: raw.conversions,
        reach: raw.reach,
        ...(raw.videoViews !== undefined ? { videoViews: raw.videoViews } : {}),
        revenue: raw.revenue,
      },
      currency: spec.currency,
      timezone: spec.timezone,
      fetchedAt: new Date(asOfMs).toISOString(),
      revision,
      sourceRef: `${STUB_SOURCE_REF_PREFIX}${this.platform}:${this.seed}:${spec.accountId}:${granularity}:${periodStart}`,
    };
  }

  private applyCorruption(page: MetricObservation[]): MetricObservation[] {
    const c = this.corruption;
    if (!c || page.length === 0) return page;
    this.corruption = undefined;
    return page.map((o, i) => {
      if (i >= c.count) return o;
      const copy = structuredClone(o) as Partial<MetricObservation> & MetricObservation;
      switch (c.how) {
        case 'negative_spend':
          copy.metrics.spend = -1;
          break;
        case 'wrong_platform':
          copy.platform = this.platform === 'google' ? 'meta' : 'google';
          break;
        case 'bad_period':
          copy.periodEnd = copy.periodStart;
          break;
        case 'missing_currency':
          delete (copy as { currency?: string }).currency;
          break;
      }
      return copy;
    });
  }
}
