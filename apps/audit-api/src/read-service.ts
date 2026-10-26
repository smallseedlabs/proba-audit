import {
  AnalyticsValidationError,
  buildTraceTree,
  verifyChain,
  type AccessContext,
  type AuditedAnalyticsReader,
  type AuditedReader,
  type AuditFacets,
  type ChainVerification,
  type Clock,
  type CompareQuery,
  type MetricsFreshness,
  type MetricsSummary,
  type MetricsStore,
  type PeriodComparison,
  type ScopeResolver,
  type StoredAuditEvent,
  type TraceListPage,
  type TraceTree,
  type AuditStore,
  type CampaignTotals,
} from '@smallseedlabs/proba-audit-core';
import { ApiError } from './http/errors.js';
import {
  API_LIMITS,
  eventCursor,
  resolveWindow,
  traceCursor,
  type CampaignsQuery,
  type ChainQuery,
  type CompareQueryParams,
  type EventsQuery,
  type FacetsQuery,
  type SummaryQueryParams,
  type TracesQuery,
} from './http/schemas.js';

export interface ReadServiceDeps {
  auditStore: AuditStore;
  metricsStore: MetricsStore;
  reader: AuditedReader;
  analytics: AuditedAnalyticsReader;
  scope: ScopeResolver;
  clock: Clock;
  chain: { maxRangeHours: number; maxEvents: number };
}

/** What a request adds to the audit event of its own read: the route and the caller's role, never data. */
export type ReadMeta = { route: string; role: string };

export interface EventsPage {
  events: StoredAuditEvent[];
  nextCursor: string | null;
  from: string | null;
  to: string | null;
  order: 'asc' | 'desc';
  limit: number;
}

export interface TracesPage extends Omit<TraceListPage, 'nextCursor'> {
  nextCursor: string | null;
  from: string | null;
  to: string | null;
  limit: number;
}

export interface DataFreshness extends MetricsFreshness {
  /**
   * The moment the figures are current to: the earlier of the last rollup and the last platform fetch
   * (a fetch not yet rolled up, or a rollup that has not seen a newer fetch, does not count). Null
   * when there is no data yet.
   */
  asOf: string | null;
}

export type SummaryResponse = MetricsSummary & { freshness: DataFreshness };
export type CompareResponse = PeriodComparison & { freshness: DataFreshness };
export interface CampaignsResponse {
  workspaceId: string;
  from: string;
  to: string;
  granularity: 'hour' | 'day';
  campaigns: CampaignTotals[];
  /** True when more campaigns exist than were returned. */
  truncated: boolean;
  freshness: DataFreshness;
}

export interface FacetsResponse extends AuditFacets {
  from: string | null;
  to: string | null;
  limit: number;
}

/**
 * The read side of the API: turns validated requests into AuditStore / MetricsStore reads, ALWAYS
 * through AuditedReader / AuditedAnalyticsReader so each request is itself an audit event under the
 * request's traceId. The workspace comes from `ctx` (the authenticated session) and is the only place
 * it is read from.
 */
export class ReadService {
  constructor(private readonly d: ReadServiceDeps) {}

  async searchEvents(ctx: AccessContext, q: EventsQuery, meta: ReadMeta): Promise<EventsPage> {
    const anchored = q.traceId !== undefined || q.goalId !== undefined || q.threadId !== undefined;
    const window = resolveWindow(q, { now: this.d.clock.now(), ...API_LIMITS.events, anchored });
    const after = q.cursor === undefined ? undefined : eventCursor.decode(q.cursor, q.order);
    const page = await this.d.reader.read(
      ctx,
      'events.search',
      { ...q, ...window },
      (p) => p.events.length,
      () =>
        this.d.auditStore.search({
          workspaceId: ctx.workspaceId,
          ...(window.from ? { from: window.from } : {}),
          ...(window.to ? { to: window.to } : {}),
          ...(q.traceId ? { traceId: q.traceId } : {}),
          ...(q.actor ? { actorId: q.actor } : {}),
          ...(q.actorType ? { actorType: q.actorType } : {}),
          ...(q.service ? { service: q.service } : {}),
          ...(q.action ? { action: q.action } : {}),
          ...(q.category ? { category: q.category } : {}),
          ...(q.outcome ? { outcome: q.outcome } : {}),
          ...(q.riskLevel ? { riskLevel: q.riskLevel } : {}),
          ...(q.goalId ? { goalId: q.goalId } : {}),
          ...(q.threadId ? { threadId: q.threadId } : {}),
          ...(q.campaignId ? { campaignId: q.campaignId } : {}),
          ...(q.q ? { text: q.q } : {}),
          order: q.order,
          limit: q.limit,
          ...(after ? { after } : {}),
        }),
      meta
    );
    return {
      events: page.events,
      nextCursor: page.nextCursor ? eventCursor.encode(page.nextCursor, q.order) : null,
      from: window.from ?? null,
      to: window.to ?? null,
      order: q.order,
      limit: q.limit,
    };
  }

  async getEvent(ctx: AccessContext, eventId: string, meta: ReadMeta): Promise<StoredAuditEvent> {
    const event = await this.d.reader.read(ctx, 'events.get', { eventId }, (e) => (e ? 1 : 0), () => this.d.auditStore.getEvent(ctx.workspaceId, eventId), meta);
    if (!event) throw new ApiError(404, 'not_found', 'There is no event with this id.');
    return event;
  }

  async getTrace(ctx: AccessContext, traceId: string, meta: ReadMeta): Promise<TraceTree> {
    const page = await this.d.reader.read(
      ctx,
      'traces.get',
      { traceId },
      (p) => p.events.length,
      () => this.d.auditStore.search({ workspaceId: ctx.workspaceId, traceId, order: 'asc', limit: API_LIMITS.traceMaxEvents }),
      meta
    );
    if (page.events.length === 0) throw new ApiError(404, 'not_found', 'There is no trace with this id.');
    return buildTraceTree(traceId, page.events, { truncated: page.nextCursor !== null });
  }

  async listTraces(ctx: AccessContext, q: TracesQuery, meta: ReadMeta): Promise<TracesPage> {
    const window = resolveWindow(q, { now: this.d.clock.now(), ...API_LIMITS.traces });
    const after = q.cursor === undefined ? undefined : traceCursor.decode(q.cursor);
    const page = await this.d.reader.read(
      ctx,
      'traces.list',
      { ...q, ...window },
      (p) => p.traces.length,
      () =>
        this.d.auditStore.listTraces({
          workspaceId: ctx.workspaceId,
          ...(window.from ? { from: window.from } : {}),
          ...(window.to ? { to: window.to } : {}),
          limit: q.limit,
          ...(after ? { after } : {}),
        }),
      meta
    );
    return {
      traces: page.traces,
      nextCursor: page.nextCursor ? traceCursor.encode(page.nextCursor) : null,
      from: window.from ?? null,
      to: window.to ?? null,
      limit: q.limit,
    };
  }

  async facets(ctx: AccessContext, q: FacetsQuery, meta: ReadMeta): Promise<FacetsResponse> {
    const window = resolveWindow(q, { now: this.d.clock.now(), ...API_LIMITS.facets });
    const facets = await this.d.reader.read(
      ctx,
      'facets.list',
      { ...q, ...window },
      (f) => Object.values(f.facets).reduce((n, values) => n + values.length, 0),
      () => this.d.auditStore.facets({ workspaceId: ctx.workspaceId, ...window, limit: q.limit }),
      meta
    );
    return { ...facets, from: window.from ?? null, to: window.to ?? null, limit: q.limit };
  }

  /** Verify the caller's workspace chain over a bounded ingestion range. */
  async verifyChain(ctx: AccessContext, q: ChainQuery, meta: ReadMeta): Promise<ChainVerification> {
    const span = Date.parse(q.to) - Date.parse(q.from);
    const issues: { path: string; message: string }[] = [];
    if (!(span > 0)) issues.push({ path: 'to', message: 'must be after from' });
    else if (span > this.d.chain.maxRangeHours * 3_600_000) issues.push({ path: 'to', message: `the range is longer than ${this.d.chain.maxRangeHours} hours` });
    if (issues.length > 0) throw new ApiError(400, 'invalid_query', 'The range to verify is not valid.', issues);
    return this.d.reader.read(
      ctx,
      'chain.verify',
      q,
      (r) => r.checked,
      () => verifyChain(this.d.auditStore, ctx.workspaceId, { from: q.from, to: q.to }, { maxEvents: this.d.chain.maxEvents }),
      meta
    );
  }

  async summary(ctx: AccessContext, q: SummaryQueryParams): Promise<SummaryResponse> {
    const result = await this.analytics(() => this.d.analytics.getMetricsSummary(ctx, { from: q.from, to: q.to, granularity: q.granularity, ...(q.campaignId ? { campaignId: q.campaignId } : {}) }));
    return { ...result, freshness: await this.freshness(ctx) };
  }

  async compare(ctx: AccessContext, q: CompareQueryParams): Promise<CompareResponse> {
    const query: CompareQuery = {
      granularity: q.granularity,
      current: { from: q.currentFrom, to: q.currentTo },
      ...(q.previousFrom && q.previousTo ? { previous: { from: q.previousFrom, to: q.previousTo } } : {}),
      ...(q.campaignId ? { campaignId: q.campaignId } : {}),
    };
    const result = await this.analytics(() => this.d.analytics.comparePeriods(ctx, query));
    return { ...result, freshness: await this.freshness(ctx) };
  }

  /** Top campaigns by spend: the per-campaign rows of the summary, cut to `limit`. */
  async campaigns(ctx: AccessContext, q: CampaignsQuery): Promise<CampaignsResponse> {
    const result = await this.analytics(() => this.d.analytics.getMetricsSummary(ctx, { from: q.from, to: q.to, granularity: q.granularity }));
    const all = result.campaigns ?? [];
    return {
      workspaceId: result.workspaceId,
      from: result.from,
      to: result.to,
      granularity: result.granularity,
      campaigns: all.slice(0, q.limit),
      truncated: all.length > q.limit || result.campaignsTruncated === true,
      freshness: await this.freshness(ctx),
    };
  }

  private async analytics<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (err) {
      if (err instanceof AnalyticsValidationError) throw new ApiError(400, 'invalid_query', 'The analytics query is not valid.', err.issues);
      throw err;
    }
  }

  private async freshness(ctx: AccessContext): Promise<DataFreshness> {
    const scope = await this.d.scope(ctx);
    const f = await this.d.metricsStore.getFreshness(scope.accounts);
    const asOf = f.rollupsComputedAt && f.observationsFetchedAt ? new Date(Math.min(Date.parse(f.rollupsComputedAt), Date.parse(f.observationsFetchedAt))).toISOString() : null;
    return { asOf, ...f };
  }
}
