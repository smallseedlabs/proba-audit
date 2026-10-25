import type { ClickHouseClient } from '@clickhouse/client';
import {
  AUDIT_QUERY_DEFAULT_LIMIT,
  AUDIT_QUERY_MAX_LIMIT,
  type AppendResult,
  type AuditAggregateQuery,
  type AuditAggregateRow,
  type AuditEventRef,
  type AuditFilter,
  type AuditGroupBy,
  type AuditQuery,
  type AuditStore,
  type ChainHead,
  type ReadChainOptions,
  type StoredAuditEvent,
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
         AND event_id IN {ids:Array(UUID)}`,
      {
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
    // ingested_at is not in the sorting key: this reads the workspace. Meant for verification jobs.
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

  getTrace(
    traceId: string,
    options: { workspaceId?: string; limit?: number } = {}
  ): Promise<StoredAuditEvent[]> {
    return this.query({ traceId, workspaceId: options.workspaceId, order: 'asc', limit: options.limit });
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
