/**
 * Read-side vocabulary of the AuditStore port: keyset-paginated search, trace
 * summaries, facets and the span tree. Pure types and helpers, no I/O.
 */

import type { AuditFilter, AuditOutcome, AuditRiskLevel, StoredAuditEvent } from './audit.js';

/** Position after which the next page of a search starts (the sort key of the last row returned). */
export interface AuditCursor {
  /** occurredAt of the last event returned (UTC ISO 8601, Z). */
  occurredAt: string;
  eventId: string;
}

export interface AuditSearchQuery extends AuditFilter {
  /** Case-insensitive substring matched against action, target type and target id. */
  text?: string;
  /** Sort by occurredAt, then eventId. Default 'desc' (newest first). */
  order?: 'asc' | 'desc';
  /** Default 50, maximum 1000. */
  limit?: number;
  /** Continue after this position, in the chosen order. */
  after?: AuditCursor;
}

export const AUDIT_SEARCH_DEFAULT_LIMIT = 50;
export const AUDIT_SEARCH_MAX_LIMIT = 1000;

export interface AuditSearchPage {
  events: StoredAuditEvent[];
  /** Set when more events exist after this page; pass it as `after`. */
  nextCursor: AuditCursor | null;
}

/** Position after which the next page of traces starts. */
export interface TraceCursor {
  /** Last activity of the last trace returned. */
  lastEventAt: string;
  traceId: string;
}

export interface TraceListQuery {
  workspaceId: string;
  /** Traces with at least one event whose occurredAt is in [from, to). */
  from?: string;
  to?: string;
  /** Default 25, maximum 200. */
  limit?: number;
  after?: TraceCursor;
}

export const TRACE_LIST_DEFAULT_LIMIT = 25;
export const TRACE_LIST_MAX_LIMIT = 200;

export interface TraceSummary {
  traceId: string;
  /** Action of the root event (the earliest event without a parent span; the earliest event if none has no parent). */
  rootAction: string;
  rootService: string;
  /** Earliest occurredAt in the trace. */
  startedAt: string;
  /** Latest occurredAt in the trace: what "recent" is sorted by. */
  lastEventAt: string;
  eventCount: number;
  /** Worst outcome of the trace's events (failure > denied > partial > success). */
  outcome: AuditOutcome;
  /** Highest risk level among the trace's events, when any event has one. */
  riskLevel?: AuditRiskLevel;
  /** From the first event's occurredAt to the latest event end (occurredAt + durationMs). */
  durationMs: number;
}

export interface TraceListPage {
  traces: TraceSummary[];
  nextCursor: TraceCursor | null;
}

export const AUDIT_FACET_NAMES = [
  'service',
  'action',
  'category',
  'outcome',
  'riskLevel',
  'actorType',
  'actorId',
  'campaignId',
] as const;
export type AuditFacetName = (typeof AUDIT_FACET_NAMES)[number];

export interface AuditFacetsQuery {
  workspaceId: string;
  from?: string;
  to?: string;
  /** Distinct values returned per facet, most frequent first. Default 50, maximum 200. */
  limit?: number;
}

export const AUDIT_FACET_DEFAULT_LIMIT = 50;
export const AUDIT_FACET_MAX_LIMIT = 200;

export interface AuditFacetValue {
  value: string;
  count: number;
}

export interface AuditFacets {
  facets: Record<AuditFacetName, AuditFacetValue[]>;
  /** Facets that have more distinct values than were returned. */
  truncated: AuditFacetName[];
}

const OUTCOME_SEVERITY: Record<AuditOutcome, number> = { success: 0, partial: 1, denied: 2, failure: 3 };
const RISK_SEVERITY: Record<AuditRiskLevel, number> = { low: 1, medium: 2, high: 3 };

/** The worst of several outcomes: failure > denied > partial > success. */
export function worstOutcome(outcomes: Iterable<AuditOutcome>): AuditOutcome {
  let worst: AuditOutcome = 'success';
  for (const o of outcomes) if (OUTCOME_SEVERITY[o] > OUTCOME_SEVERITY[worst]) worst = o;
  return worst;
}

/** The highest of several risk levels, undefined when none is set. */
export function highestRisk(levels: Iterable<AuditRiskLevel | undefined>): AuditRiskLevel | undefined {
  let top: AuditRiskLevel | undefined;
  for (const l of levels) if (l !== undefined && (top === undefined || RISK_SEVERITY[l] > RISK_SEVERITY[top])) top = l;
  return top;
}

/** Orders events as root candidates: no parent span first, then earliest occurredAt, then eventId. */
function compareRootCandidates(a: StoredAuditEvent, b: StoredAuditEvent): number {
  const parent = (e: StoredAuditEvent): number => (e.parentSpanId === undefined ? 0 : 1);
  return parent(a) - parent(b) || Date.parse(a.occurredAt) - Date.parse(b.occurredAt) || a.eventId.localeCompare(b.eventId);
}

/** The root of a trace: earliest event without a parent span, else the earliest event. */
export function pickRootEvent(events: readonly StoredAuditEvent[]): StoredAuditEvent | undefined {
  let root: StoredAuditEvent | undefined;
  for (const e of events) if (!root || compareRootCandidates(e, root) < 0) root = e;
  return root;
}

/** Summary of one trace from all of its events (the shared definition for every store). */
export function summarizeTrace(events: readonly StoredAuditEvent[]): TraceSummary | undefined {
  const root = pickRootEvent(events);
  if (!root) return undefined;
  let start = Infinity;
  let last = -Infinity;
  let end = -Infinity;
  for (const e of events) {
    const t = Date.parse(e.occurredAt);
    start = Math.min(start, t);
    last = Math.max(last, t);
    end = Math.max(end, t + (e.durationMs ?? 0));
  }
  const riskLevel = highestRisk(events.map((e) => e.riskLevel));
  return {
    traceId: root.traceId,
    rootAction: root.action,
    rootService: root.service,
    startedAt: new Date(start).toISOString(),
    lastEventAt: new Date(last).toISOString(),
    eventCount: events.length,
    outcome: worstOutcome(events.map((e) => e.outcome)),
    ...(riskLevel ? { riskLevel } : {}),
    durationMs: Math.round(end - start),
  };
}
