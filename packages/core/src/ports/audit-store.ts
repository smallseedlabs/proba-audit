/**
 * AuditStore port: append-only storage of StoredAuditEvents with queries and
 * aggregates. Nothing is ever updated or deleted through this port.
 */

import type {
  AppendResult,
  AuditAggregateQuery,
  AuditAggregateRow,
  AuditEventRef,
  AuditQuery,
  ChainHead,
  ReadChainOptions,
  StoredAuditEvent,
} from '../domain/audit.js';
import type {
  AuditFacets,
  AuditFacetsQuery,
  AuditSearchPage,
  AuditSearchQuery,
  TraceListPage,
  TraceListQuery,
} from '../domain/audit-read.js';

export interface AuditStore {
  /**
   * Append a batch, deduplicating by eventId (also within the batch):
   * - same eventId and same content (see sameContent): skipped, counted in `duplicates`;
   * - same eventId but different content: NOT written, its id is returned in `conflicts`.
   * The first occurrence in the batch wins. Redelivery is therefore safe.
   */
  appendBatch(events: StoredAuditEvent[]): Promise<AppendResult>;
  /** Stored events with the given ids (those that exist). Order is unspecified. */
  findExisting(refs: AuditEventRef[]): Promise<StoredAuditEvent[]>;
  query(query: AuditQuery): Promise<StoredAuditEvent[]>;
  /**
   * Keyset-paginated search for the read API: filters, free text on action and target,
   * sorted by (occurredAt, eventId) in the requested order. Reads one extra row to know
   * whether `nextCursor` is needed. Use this instead of `query` (offset paging) for UIs.
   */
  search(query: AuditSearchQuery): Promise<AuditSearchPage>;
  /** One event by id, only when it belongs to `workspaceId`; null otherwise. */
  getEvent(workspaceId: string, eventId: string): Promise<StoredAuditEvent | null>;
  /**
   * Recently active traces of a workspace, newest activity first, with a summary each
   * (see summarizeTrace). A trace is listed when one of its events falls in [from, to); the
   * summary always covers all of the trace's events.
   */
  listTraces(query: TraceListQuery): Promise<TraceListPage>;
  /** Distinct values (with counts) for the filter facets of one workspace, capped per facet. */
  facets(query: AuditFacetsQuery): Promise<AuditFacets>;
  /**
   * All events of one trace of `workspaceId`, oldest first. The workspace is required (like getEvent): a trace id
   * alone never reads across workspaces, and events of the same trace id in another workspace are not returned.
   */
  getTrace(workspaceId: string, traceId: string, options?: { limit?: number }): Promise<StoredAuditEvent[]>;
  aggregate(query: AuditAggregateQuery): Promise<AuditAggregateRow[]>;
  /** Most recently ingested event of a workspace, to continue its hash chain; null if none. */
  getChainHead(workspaceId: string): Promise<ChainHead | null>;
  /** One workspace's events in chain order (ingestedAt, eventId), for chain verification. */
  readChain(workspaceId: string, options?: ReadChainOptions): Promise<StoredAuditEvent[]>;
  /** Throws if the backing service is unreachable. */
  ping(): Promise<void>;
  close(): Promise<void>;
}
