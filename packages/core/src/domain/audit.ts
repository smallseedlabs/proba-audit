/**
 * Audit domain types used by the AuditStore port.
 *
 * The event shapes themselves (AuditEvent, StoredAuditEvent) come from
 * proba-protocol; this file only adds the query/aggregate vocabulary.
 */

import type {
  AuditActorType,
  AuditCategory,
  AuditOutcome,
  AuditRiskLevel,
} from '@smallseedlabs/proba-protocol/audit';

export type {
  AuditEvent,
  StoredAuditEvent,
  AuditActorType,
  AuditCategory,
  AuditOutcome,
  AuditRiskLevel,
} from '@smallseedlabs/proba-protocol/audit';

/**
 * Filters shared by queries and aggregates. All fields are optional and
 * combined with AND. Times are UTC ISO 8601 with a trailing Z; `from` is
 * inclusive and `to` is exclusive, both on `occurredAt`.
 */
export interface AuditFilter {
  workspaceId?: string;
  traceId?: string;
  userId?: string;
  goalId?: string;
  threadId?: string;
  campaignId?: string;
  actorType?: AuditActorType;
  actorId?: string;
  service?: string;
  category?: AuditCategory;
  action?: string;
  /** Actions that start with this text (for example `goal.` for the goal domain). Literal, not a pattern. */
  actionPrefix?: string;
  outcome?: AuditOutcome;
  riskLevel?: AuditRiskLevel;
  from?: string;
  to?: string;
}

export interface AuditQuery extends AuditFilter {
  /** Sort by occurredAt (then eventId). Default: 'desc' (newest first). */
  order?: 'asc' | 'desc';
  /** Default 100, maximum 1000. */
  limit?: number;
  offset?: number;
}

export const AUDIT_QUERY_DEFAULT_LIMIT = 100;
export const AUDIT_QUERY_MAX_LIMIT = 1000;

export type AuditGroupBy =
  | 'category'
  | 'action'
  | 'outcome'
  | 'service'
  | 'actorType'
  | 'riskLevel'
  | 'currency'
  | 'hour'
  | 'day';

export interface AuditAggregateQuery {
  filter: AuditFilter;
  groupBy: AuditGroupBy[];
}

export interface AuditAggregateRow {
  /** Value of each requested groupBy key. `hour`/`day` are UTC ISO bucket starts. */
  keys: Partial<Record<AuditGroupBy, string>>;
  count: number;
  durationMsSum: number;
  tokensInSum: number;
  tokensOutSum: number;
  /** Sum of cost.amount. Group by `currency` to avoid mixing currencies. */
  costAmountSum: number;
}

export interface AppendResult {
  inserted: number;
  /** Identical events skipped because an event with the same eventId and the same content is already stored. */
  duplicates: number;
  /**
   * eventIds that were NOT written because an event with that id is already
   * stored (or earlier in the batch) with different content. The caller must
   * dead-letter and log them.
   */
  conflicts: string[];
}

export interface ChainHead {
  eventId: string;
  hash: string;
  ingestedAt: string;
}

/** Locates a stored event cheaply: workspace and time narrow the ClickHouse scan. */
export interface AuditEventRef {
  eventId: string;
  workspaceId: string;
  /** The event's occurredAt (UTC ISO 8601, Z). */
  occurredAt: string;
}

/**
 * Options for AuditStore.readChain: events of one workspace in chain order
 * (ingestedAt, then eventId). `from` is inclusive and `to` exclusive, on ingestedAt.
 */
export interface ReadChainOptions {
  from?: string;
  to?: string;
  /** Continue after this event (keyset cursor in the chosen order). */
  after?: { ingestedAt: string; eventId: string };
  /** Default 'asc' (oldest first). */
  order?: 'asc' | 'desc';
  /** Default 1000, maximum 10000. */
  limit?: number;
}

export const CHAIN_READ_DEFAULT_LIMIT = 1000;
export const CHAIN_READ_MAX_LIMIT = 10_000;
