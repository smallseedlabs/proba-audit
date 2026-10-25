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
  /** All events of one trace, oldest first. */
  getTrace(traceId: string, options?: { workspaceId?: string; limit?: number }): Promise<StoredAuditEvent[]>;
  aggregate(query: AuditAggregateQuery): Promise<AuditAggregateRow[]>;
  /** Most recently ingested event of a workspace, to continue its hash chain; null if none. */
  getChainHead(workspaceId: string): Promise<ChainHead | null>;
  /** One workspace's events in chain order (ingestedAt, eventId), for chain verification. */
  readChain(workspaceId: string, options?: ReadChainOptions): Promise<StoredAuditEvent[]>;
  /** Throws if the backing service is unreachable. */
  ping(): Promise<void>;
  close(): Promise<void>;
}
