import type { ClickHouseClient } from '@clickhouse/client';
import {
  AUDIT_FACET_DEFAULT_LIMIT,
  AUDIT_FACET_MAX_LIMIT,
  AUDIT_FACET_NAMES,
  AUDIT_QUERY_DEFAULT_LIMIT,
  AUDIT_QUERY_MAX_LIMIT,
  AUDIT_SEARCH_DEFAULT_LIMIT,
  AUDIT_SEARCH_MAX_LIMIT,
  OWNED_CAMPAIGNS_MAX_LIMIT,
  TRACE_LIST_DEFAULT_LIMIT,
  TRACE_LIST_MAX_LIMIT,
  type AppendResult,
  type AuditAggregateQuery,
  type AuditAggregateRow,
  type AuditEventRef,
  type AuditFacetName,
  type AuditFacetValue,
  type AuditFacets,
  type AuditFacetsQuery,
  type AuditFilter,
  type AuditGroupBy,
  type AuditQuery,
  type AuditSearchPage,
  type AuditSearchQuery,
  type AuditStore,
  type ChainHead,
  type OwnedCampaignsQuery,
  type ReadChainOptions,
  type StoredAuditEvent,
  type TraceListPage,
  type TraceListQuery,
  type TraceSummary,
  CHAIN_READ_DEFAULT_LIMIT,
  CHAIN_READ_MAX_LIMIT,
  sameContent,
} from '@smallseedlabs/proba-audit-core';

const TS = (name: string) => `parseDateTime64BestEffort({${name}:String}, 3, 'UTC')`;

export interface AuditRow {
  event_id: string;
  version: number;
  trace_id: string;
  span_id: string;
  parent_span_id: string | null;
  workspace_id: string;
  user_id: string | null;
  goal_id: string | null;
  thread_id: string | null;
  campaign_id: string | null;
  actor_type: StoredAuditEvent['actor']['type'];
  actor_id: string;
  service: string;
  action: string;
  category: StoredAuditEvent['category'];
  target_type: string | null;
  target_id: string | null;
  outcome: StoredAuditEvent['outcome'];
  error_code: string | null;
  error_message: string | null;
  risk_level: NonNullable<StoredAuditEvent['riskLevel']> | null;
  cost_tokens_in: number | null;
  cost_tokens_out: number | null;
  cost_currency: string | null;
  cost_amount: number | null;
  duration_ms: number | null;
  occurred_at: string;
  details: string;
  tags: string[];
  prev_hash: string | null;
  hash: string;
  ingested_at: string;
  schema_version: number;
  content_digest?: string | null;
}

export function toRow(e: StoredAuditEvent): AuditRow {
  return {
    event_id: e.eventId,
    version: e.version,
    trace_id: e.traceId,
    span_id: e.spanId,
    parent_span_id: e.parentSpanId ?? null,
    workspace_id: e.workspaceId,
    user_id: e.userId ?? null,
    goal_id: e.goalId ?? null,
    thread_id: e.threadId ?? null,
    campaign_id: e.campaignId ?? null,
    actor_type: e.actor.type,
    actor_id: e.actor.id,
    service: e.service,
    action: e.action,
    category: e.category,
    target_type: e.target?.type ?? null,
    target_id: e.target?.id ?? null,
    outcome: e.outcome,
    error_code: e.errorCode ?? null,
    error_message: e.errorMessage ?? null,
    risk_level: e.riskLevel ?? null,
    cost_tokens_in: e.cost?.tokensIn ?? null,
    cost_tokens_out: e.cost?.tokensOut ?? null,
    cost_currency: e.cost?.currency ?? null,
    cost_amount: e.cost?.amount ?? null,
    duration_ms: e.durationMs ?? null,
    occurred_at: e.occurredAt,
    details: JSON.stringify(e.details),
    tags: e.tags ?? [],
    prev_hash: e.prevHash,
    hash: e.hash,
    ingested_at: e.ingestedAt,
    schema_version: e.schemaVersion,
    content_digest: e.contentDigest ?? null,
  };
}

/** Optional fields are omitted when null. An empty `tags` array reads back as absent. */
export function fromRow(r: AuditRow): StoredAuditEvent {
  const hasCost =
    r.cost_tokens_in !== null || r.cost_tokens_out !== null || r.cost_currency !== null || r.cost_amount !== null;
  return {
    version: r.version as 1,
    eventId: r.event_id,
    traceId: r.trace_id,
    spanId: r.span_id,
    ...(r.parent_span_id !== null ? { parentSpanId: r.parent_span_id } : {}),
    workspaceId: r.workspace_id,
    ...(r.user_id !== null ? { userId: r.user_id } : {}),
    ...(r.goal_id !== null ? { goalId: r.goal_id } : {}),
    ...(r.thread_id !== null ? { threadId: r.thread_id } : {}),
    ...(r.campaign_id !== null ? { campaignId: r.campaign_id } : {}),
    actor: { type: r.actor_type, id: r.actor_id },
    service: r.service,
    action: r.action,
    category: r.category,
    ...(r.target_type !== null && r.target_id !== null ? { target: { type: r.target_type, id: r.target_id } } : {}),
    outcome: r.outcome,
    ...(r.error_code !== null ? { errorCode: r.error_code } : {}),
    ...(r.error_message !== null ? { errorMessage: r.error_message } : {}),
    ...(r.risk_level !== null ? { riskLevel: r.risk_level } : {}),
    ...(hasCost
      ? {
          cost: {
            ...(r.cost_tokens_in !== null ? { tokensIn: Number(r.cost_tokens_in) } : {}),
            ...(r.cost_tokens_out !== null ? { tokensOut: Number(r.cost_tokens_out) } : {}),
            ...(r.cost_currency !== null ? { currency: r.cost_currency } : {}),
            ...(r.cost_amount !== null ? { amount: Number(r.cost_amount) } : {}),
          },
        }
      : {}),
    ...(r.duration_ms !== null ? { durationMs: Number(r.duration_ms) } : {}),
    occurredAt: r.occurred_at,
    details: JSON.parse(r.details) as Record<string, unknown>,
    ...(r.tags.length > 0 ? { tags: r.tags } : {}),
    prevHash: r.prev_hash,
    hash: r.hash,
    ingestedAt: r.ingested_at,
    schemaVersion: r.schema_version,
    ...(r.content_digest ? { contentDigest: r.content_digest } : {}),
  };
}

export interface WhereClause {
  sql: string;
  params: Record<string, unknown>;
}

/** Build the WHERE clause (with bound parameters) for an AuditFilter. */
export function buildAuditWhere(f: AuditFilter): WhereClause {
  const clauses: string[] = [];
  const params: Record<string, unknown> = {};
  const eq = (column: string, name: string, type: string, value: string | undefined): void => {
    if (value === undefined) return;
    clauses.push(`${column} = {${name}:${type}}`);
    params[name] = value;
  };
  eq('workspace_id', 'workspaceId', 'String', f.workspaceId);
  eq('trace_id', 'traceId', 'UUID', f.traceId);
  eq('user_id', 'userId', 'UUID', f.userId);
  eq('goal_id', 'goalId', 'UUID', f.goalId);
  eq('thread_id', 'threadId', 'UUID', f.threadId);
  eq('campaign_id', 'campaignId', 'String', f.campaignId);
  eq('actor_type', 'actorType', 'String', f.actorType);
  eq('actor_id', 'actorId', 'String', f.actorId);
  eq('service', 'service', 'String', f.service);
  eq('category', 'category', 'String', f.category);
  eq('action', 'action', 'String', f.action);
  if (f.actionPrefix !== undefined) {
    clauses.push('startsWith(toString(action), {actionPrefix:String})');
    params.actionPrefix = f.actionPrefix;
  }
  eq('outcome', 'outcome', 'String', f.outcome);
  eq('risk_level', 'riskLevel', 'String', f.riskLevel);
  if (f.from !== undefined) {
    clauses.push(`occurred_at >= ${TS('from')}`);
    params.from = f.from;
  }
  if (f.to !== undefined) {
    clauses.push(`occurred_at < ${TS('to')}`);
    params.to = f.to;
  }
  return { sql: clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '', params };
}

/** Filters plus free text on action / target and an optional keyset cursor, for GET /v1/events. */
export function buildSearchWhere(query: AuditSearchQuery): WhereClause {
  const base = buildAuditWhere(query);
  const clauses: string[] = base.sql === '' ? [] : [base.sql.replace(/^WHERE /, '')];
  const params = { ...base.params };
  if (query.text !== undefined && query.text !== '') {
    clauses.push(
      `(positionCaseInsensitive(toString(action), {text:String}) > 0
        OR positionCaseInsensitive(ifNull(target_type, ''), {text:String}) > 0
        OR positionCaseInsensitive(ifNull(target_id, ''), {text:String}) > 0)`
    );
    params.text = query.text;
  }
  if (query.after !== undefined) {
    const op = (query.order ?? 'desc') === 'asc' ? '>' : '<';
    clauses.push(`(occurred_at, event_id) ${op} (${TS('afterAt')}, {afterId:UUID})`);
    params.afterAt = query.after.occurredAt;
    params.afterId = query.after.eventId;
  }
  return { sql: clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '', params };
}

/** Column expression and extra condition per facet. */
const FACET_SQL: Record<AuditFacetName, { expr: string; where?: string }> = {
  service: { expr: 'toString(service)' },
  action: { expr: 'toString(action)' },
  category: { expr: 'toString(category)' },
  outcome: { expr: 'toString(outcome)' },
  riskLevel: { expr: 'toString(risk_level)', where: 'risk_level IS NOT NULL' },
  actorType: { expr: 'toString(actor_type)' },
  actorId: { expr: 'actor_id' },
  campaignId: { expr: 'campaign_id', where: 'campaign_id IS NOT NULL' },
};

const GROUP_EXPR: Record<AuditGroupBy, string> = {
  category: 'toString(category)',
  action: 'toString(action)',
  outcome: 'toString(outcome)',
  service: 'toString(service)',
  actorType: 'toString(actor_type)',
  riskLevel: "ifNull(toString(risk_level), '')",
  currency: "ifNull(toString(cost_currency), '')",
  hour: "formatDateTime(toStartOfHour(occurred_at, 'UTC'), '%Y-%m-%dT%H:%i:%S.000Z', 'UTC')",
  day: "formatDateTime(toStartOfDay(occurred_at, 'UTC'), '%Y-%m-%dT%H:%i:%S.000Z', 'UTC')",
};

export function buildAggregateSql(query: AuditAggregateQuery): WhereClause {
  const where = buildAuditWhere(query.filter);
  const keys = query.groupBy.map((k, i) => `${GROUP_EXPR[k]} AS k${i}`);
  const select = [
    ...keys,
    'count() AS cnt',
    'toFloat64(sum(ifNull(duration_ms, 0))) AS duration_sum',
    'toFloat64(sum(ifNull(cost_tokens_in, 0))) AS tokens_in_sum',
    'toFloat64(sum(ifNull(cost_tokens_out, 0))) AS tokens_out_sum',
    'toFloat64(sum(ifNull(cost_amount, 0))) AS cost_sum',
  ];
  const group = query.groupBy.length > 0 ? `GROUP BY ${query.groupBy.map((_, i) => `k${i}`).join(', ')} ORDER BY ${query.groupBy.map((_, i) => `k${i}`).join(', ')}` : '';
  return {
    sql: `SELECT ${select.join(', ')} FROM audit_events ${where.sql} ${group}`,
    params: where.params,
  };
}

export interface ClickHouseAuditStoreOptions {
  client: ClickHouseClient;
  /** Close the client when the store is closed. */
  ownsClient?: boolean;
}

/**
 * AuditStore on ClickHouse (table `audit_events`, see migrations/clickhouse).
 * Append-only: this class only INSERTs and SELECTs.
 */
export class ClickHouseAuditStore implements AuditStore {
  private readonly client: ClickHouseClient;
  private readonly ownsClient: boolean;

  constructor(options: ClickHouseAuditStoreOptions) {
    this.client = options.client;
    this.ownsClient = options.ownsClient ?? false;
  }

  async appendBatch(events: StoredAuditEvent[]): Promise<AppendResult> {
    if (events.length === 0) return { inserted: 0, duplicates: 0, conflicts: [] };

    // First occurrence in the batch wins; a later one is a duplicate or a conflict.
    const firstById = new Map<string, StoredAuditEvent>();
    let duplicates = 0;
    const conflicts = new Set<string>();
    for (const e of events) {
      const first = firstById.get(e.eventId);
      if (!first) firstById.set(e.eventId, e);
      else if (sameContent(first, e)) duplicates += 1;
      else conflicts.add(e.eventId);
    }
    const unique = [...firstById.values()];

    const stored = new Map((await this.findExisting(unique)).map((e) => [e.eventId, e]));
    const fresh: StoredAuditEvent[] = [];
    for (const e of unique) {
      const existing = stored.get(e.eventId);
      if (!existing) fresh.push(e);
      else if (sameContent(existing, e)) duplicates += 1;
      else conflicts.add(e.eventId);
    }

    if (fresh.length > 0) {
      await this.client.insert({ table: 'audit_events', values: fresh.map(toRow), format: 'JSONEachRow' });
    }
    return { inserted: fresh.length, duplicates, conflicts: [...conflicts] };
  }

  /** Look up stored copies, restricted to the refs' workspaces and time span so the primary index prunes the scan. */
  async findExisting(refs: AuditEventRef[]): Promise<StoredAuditEvent[]> {
    if (refs.length === 0) return [];
    const times = refs.map((r) => Date.parse(r.occurredAt));
    const rows = await this.rows<AuditRow>(
      `SELECT * FROM audit_events
       WHERE workspace_id IN {workspaces:Array(String)}
         AND occurred_at >= ${TS('min')} AND occurred_at <= ${TS('max')}
         AND event_id IN {ids:Array(UUID)}
         AND has(arrayZip({refWorkspaces:Array(String)}, {refIds:Array(UUID)}), (workspace_id, event_id))`,
      {
        // The two IN lists narrow the scan; the pair check keeps an id from matching in a workspace it was not asked for.
        refWorkspaces: refs.map((r) => r.workspaceId),
        refIds: refs.map((r) => r.eventId),
        workspaces: [...new Set(refs.map((r) => r.workspaceId))],
        min: new Date(Math.min(...times)).toISOString(),
        max: new Date(Math.max(...times)).toISOString(),
        ids: [...new Set(refs.map((r) => r.eventId))],
      }
    );
    return rows.map(fromRow);
  }

  async readChain(workspaceId: string, options: ReadChainOptions = {}): Promise<StoredAuditEvent[]> {
    const limit = Math.min(options.limit ?? CHAIN_READ_DEFAULT_LIMIT, CHAIN_READ_MAX_LIMIT);
    const asc = (options.order ?? 'asc') === 'asc';
    const clauses = ['workspace_id = {workspaceId:String}'];
    const params: Record<string, unknown> = { workspaceId, limit };
    if (options.from !== undefined) {
      clauses.push(`ingested_at >= ${TS('from')}`);
      params.from = options.from;
    }
    if (options.to !== undefined) {
      clauses.push(`ingested_at < ${TS('to')}`);
      params.to = options.to;
    }
    if (options.after !== undefined) {
      clauses.push(`(ingested_at, event_id) ${asc ? '>' : '<'} (${TS('afterAt')}, {afterId:UUID})`);
      params.afterAt = options.after.ingestedAt;
      params.afterId = options.after.eventId;
    }
    const dir = asc ? 'ASC' : 'DESC';
    // ingested_at is not in the sorting key; the minmax index idx_ingested_at (0007) prunes the range, since
    // ingestion time follows write order. Without a range this reads the workspace: meant for bounded verification.
    const rows = await this.rows<AuditRow>(
      `SELECT * FROM audit_events WHERE ${clauses.join(' AND ')}
       ORDER BY ingested_at ${dir}, event_id ${dir} LIMIT {limit:UInt32}`,
      params
    );
    return rows.map(fromRow);
  }

  async query(query: AuditQuery): Promise<StoredAuditEvent[]> {
    const where = buildAuditWhere(query);
    const limit = Math.min(query.limit ?? AUDIT_QUERY_DEFAULT_LIMIT, AUDIT_QUERY_MAX_LIMIT);
    const dir = (query.order ?? 'desc') === 'asc' ? 'ASC' : 'DESC';
    const rows = await this.rows<AuditRow>(
      `SELECT * FROM audit_events ${where.sql}
       ORDER BY occurred_at ${dir}, event_id ${dir}
       LIMIT {limit:UInt32} OFFSET {offset:UInt32}`,
      { ...where.params, limit, offset: query.offset ?? 0 }
    );
    return rows.map(fromRow);
  }

  /**
   * Keyset page in sorting-key order. With a workspace and a time range (the API always sets both)
   * the primary key prunes parts and granules and ClickHouse reads in order, so LIMIT stops early.
   */
  async search(query: AuditSearchQuery): Promise<AuditSearchPage> {
    const where = buildSearchWhere(query);
    const limit = Math.min(query.limit ?? AUDIT_SEARCH_DEFAULT_LIMIT, AUDIT_SEARCH_MAX_LIMIT);
    const dir = (query.order ?? 'desc') === 'asc' ? 'ASC' : 'DESC';
    const rows = await this.rows<AuditRow>(
      `SELECT * FROM audit_events ${where.sql}
       ORDER BY occurred_at ${dir}, event_id ${dir}
       LIMIT {limit:UInt32}`,
      { ...where.params, limit: limit + 1 }
    );
    const events = rows.slice(0, limit).map(fromRow);
    const last = events[events.length - 1];
    return { events, nextCursor: rows.length > limit && last ? { occurredAt: last.occurredAt, eventId: last.eventId } : null };
  }

  async getEvent(workspaceId: string, eventId: string): Promise<StoredAuditEvent | null> {
    // event_id is not in the sorting key: the idx_event_id bloom filter skips granules.
    const rows = await this.rows<AuditRow>(
      `SELECT * FROM audit_events WHERE workspace_id = {workspaceId:String} AND event_id = {eventId:UUID} LIMIT 1`,
      { workspaceId, eventId }
    );
    return rows[0] ? fromRow(rows[0]) : null;
  }

  /**
   * Two steps. First the trace ids with activity in the window (primary key range scan, grouped by
   * trace, newest first, keyset cursor). Then the summary of exactly those traces over ALL their
   * events (idx_trace_id skips granules), so a trace that began before the window still counts fully.
   * audit_events is append-only MergeTree: there are no versions to collapse, so no FINAL/argMax here.
   */
  async listTraces(query: TraceListQuery): Promise<TraceListPage> {
    const limit = Math.min(query.limit ?? TRACE_LIST_DEFAULT_LIMIT, TRACE_LIST_MAX_LIMIT);
    const clauses = ['workspace_id = {workspaceId:String}'];
    const params: Record<string, unknown> = { workspaceId: query.workspaceId, limit: limit + 1 };
    if (query.from !== undefined) {
      clauses.push(`occurred_at >= ${TS('from')}`);
      params.from = query.from;
    }
    if (query.to !== undefined) {
      clauses.push(`occurred_at < ${TS('to')}`);
      params.to = query.to;
    }
    if (query.rootActorId !== undefined) {
      // The root of a trace is its earliest event without a parent span (pickRootEvent). It may lie before the window, so the
      // root is decided over the whole trace; the inner IN only narrows that to traces the actor appears in.
      clauses.push(
        `trace_id IN (SELECT trace_id FROM audit_events
                      WHERE workspace_id = {workspaceId:String}
                        AND trace_id IN (SELECT trace_id FROM audit_events WHERE workspace_id = {workspaceId:String} AND actor_id = {rootActorId:String})
                      GROUP BY trace_id
                      HAVING argMin(actor_id, tuple(isNotNull(parent_span_id), occurred_at, event_id)) = {rootActorId:String})`
      );
      params.rootActorId = query.rootActorId;
    }
    const having = query.after ? `HAVING (last_at, trace_id) < (${TS('afterAt')}, {afterId:UUID})` : '';
    if (query.after) {
      params.afterAt = query.after.lastEventAt;
      params.afterId = query.after.traceId;
    }
    const active = await this.rows<{ trace_id: string; last_at: string }>(
      `SELECT trace_id, max(occurred_at) AS last_at FROM audit_events
       WHERE ${clauses.join(' AND ')}
       GROUP BY trace_id ${having}
       ORDER BY last_at DESC, trace_id DESC
       LIMIT {limit:UInt32}`,
      params
    );
    const page = active.slice(0, limit);
    if (page.length === 0) return { traces: [], nextCursor: null };

    const summaries = await this.rows<{
      trace_id: string;
      root_action: string;
      root_service: string;
      start_ms: number;
      last_ms: number;
      end_ms: number;
      event_count: number;
      outcome_rank: number;
      risk_rank: number;
    }>(
      `SELECT trace_id,
              argMin(toString(action), tuple(isNotNull(parent_span_id), occurred_at, event_id)) AS root_action,
              argMin(toString(service), tuple(isNotNull(parent_span_id), occurred_at, event_id)) AS root_service,
              min(toUnixTimestamp64Milli(occurred_at)) AS start_ms,
              max(toUnixTimestamp64Milli(occurred_at)) AS last_ms,
              max(toFloat64(toUnixTimestamp64Milli(occurred_at)) + ifNull(duration_ms, 0)) AS end_ms,
              count() AS event_count,
              max(multiIf(outcome = 'failure', 3, outcome = 'denied', 2, outcome = 'partial', 1, 0)) AS outcome_rank,
              max(multiIf(risk_level = 'high', 3, risk_level = 'medium', 2, risk_level = 'low', 1, 0)) AS risk_rank
       FROM audit_events
       WHERE workspace_id = {workspaceId:String} AND trace_id IN {ids:Array(UUID)}
       GROUP BY trace_id`,
      { workspaceId: query.workspaceId, ids: page.map((r) => r.trace_id) }
    );
    const byId = new Map(summaries.map((r) => [r.trace_id, r]));
    const OUTCOMES = ['success', 'partial', 'denied', 'failure'] as const;
    const RISKS = [undefined, 'low', 'medium', 'high'] as const;
    const traces: TraceSummary[] = [];
    for (const { trace_id } of page) {
      const r = byId.get(trace_id);
      if (!r) continue;
      const risk = RISKS[Number(r.risk_rank)];
      traces.push({
        traceId: trace_id,
        rootAction: r.root_action,
        rootService: r.root_service,
        startedAt: new Date(Number(r.start_ms)).toISOString(),
        lastEventAt: new Date(Number(r.last_ms)).toISOString(),
        eventCount: Number(r.event_count),
        outcome: OUTCOMES[Number(r.outcome_rank)],
        ...(risk ? { riskLevel: risk } : {}),
        durationMs: Math.round(Number(r.end_ms) - Number(r.start_ms)),
      });
    }
    const tail = page[page.length - 1];
    return {
      traces,
      nextCursor: active.length > limit && tail ? { lastEventAt: tail.last_at, traceId: tail.trace_id } : null,
    };
  }

  async listOwnedCampaignIds(query: OwnedCampaignsQuery): Promise<string[]> {
    const limit = Math.min(query.limit ?? OWNED_CAMPAIGNS_MAX_LIMIT, OWNED_CAMPAIGNS_MAX_LIMIT);
    // goal_id and campaign_id both live on the audit events (idx_goal_id skips granules); the workspace leads the sorting key.
    const rows = await this.rows<{ campaign_id: string }>(
      `SELECT DISTINCT campaign_id FROM audit_events
       WHERE workspace_id = {workspaceId:String}
         AND campaign_id IS NOT NULL
         AND goal_id IN (
           SELECT goal_id FROM audit_events
           WHERE workspace_id = {workspaceId:String} AND action = 'goal.created' AND goal_id IS NOT NULL
             AND (actor_id = {ownerId:String} OR toString(user_id) = {ownerId:String})
         )
       ORDER BY campaign_id ASC
       LIMIT {limit:UInt32}`,
      { workspaceId: query.workspaceId, ownerId: query.ownerId, limit }
    );
    return rows.map((r) => r.campaign_id);
  }

  async facets(query: AuditFacetsQuery): Promise<AuditFacets> {
    const limit = Math.min(query.limit ?? AUDIT_FACET_DEFAULT_LIMIT, AUDIT_FACET_MAX_LIMIT);
    const where = buildAuditWhere({ workspaceId: query.workspaceId, from: query.from, to: query.to });
    const results = await Promise.all(
      AUDIT_FACET_NAMES.map(async (name) => {
        const f = FACET_SQL[name];
        const sql = f.where ? `${where.sql} AND ${f.where}` : where.sql;
        const rows = await this.rows<{ v: string; c: number }>(
          `SELECT ${f.expr} AS v, count() AS c FROM audit_events ${sql}
           GROUP BY v ORDER BY c DESC, v ASC LIMIT {limit:UInt32}`,
          { ...where.params, limit: limit + 1 }
        );
        const values: AuditFacetValue[] = rows.slice(0, limit).map((r) => ({ value: r.v, count: Number(r.c) }));
        return { name, values, truncated: rows.length > limit };
      })
    );
    const facets = {} as Record<AuditFacetName, AuditFacetValue[]>;
    const truncated: AuditFacetName[] = [];
    for (const r of results) {
      facets[r.name] = r.values;
      if (r.truncated) truncated.push(r.name);
    }
    return { facets, truncated };
  }

  getTrace(workspaceId: string, traceId: string, options: { limit?: number } = {}): Promise<StoredAuditEvent[]> {
    return this.query({ traceId, workspaceId, order: 'asc', limit: options.limit });
  }

  async aggregate(query: AuditAggregateQuery): Promise<AuditAggregateRow[]> {
    const built = buildAggregateSql(query);
    const rows = await this.rows<Record<string, string | number>>(built.sql, built.params);
    return rows.map((r) => ({
      keys: Object.fromEntries(query.groupBy.map((k, i) => [k, String(r[`k${i}`])])),
      count: Number(r.cnt),
      durationMsSum: Number(r.duration_sum),
      tokensInSum: Number(r.tokens_in_sum),
      tokensOutSum: Number(r.tokens_out_sum),
      costAmountSum: Number(r.cost_sum),
    }));
  }

  async getChainHead(workspaceId: string): Promise<ChainHead | null> {
    // Note: ingested_at is not in the sorting key, so this scans the workspace.
    // Callers should cache the head in memory after the first read.
    const rows = await this.rows<{ event_id: string; hash: string; ingested_at: string }>(
      `SELECT event_id, hash, ingested_at FROM audit_events
       WHERE workspace_id = {workspaceId:String}
       ORDER BY ingested_at DESC, event_id DESC LIMIT 1`,
      { workspaceId }
    );
    return rows[0] ? { eventId: rows[0].event_id, hash: rows[0].hash, ingestedAt: rows[0].ingested_at } : null;
  }

  async countEvents(workspaceId: string): Promise<number> {
    const rows = await this.rows<{ n: string | number }>(
      'SELECT count() AS n FROM audit_events WHERE workspace_id = {workspaceId:String}',
      { workspaceId }
    );
    return Number(rows[0]?.n ?? 0);
  }

  async ping(): Promise<void> {
    const result = await this.client.ping();
    if (!result.success) throw result.error;
  }

  async close(): Promise<void> {
    if (this.ownsClient) await this.client.close();
  }

  private async rows<T>(query: string, params?: Record<string, unknown>): Promise<T[]> {
    const rs = await this.client.query({ query, query_params: params, format: 'JSONEachRow' });
    return rs.json<T>();
  }
}
