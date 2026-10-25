/**
 * AuditStore port: append-only storage of StoredAuditEvents with queries and
 * aggregates. Nothing is ever updated or deleted through this port.
 */

import type {
  AppendResult,
  AuditAggregateQuery,
  AuditAggregateRow,
  AuditQuery,
  ChainHead,
  StoredAuditEvent,
} from '../domain/audit.js';

export interface AuditStore {
  /**
   * Append a batch. Events whose eventId is already stored (or repeated in the
   * batch) are skipped and counted as duplicates, so redelivery is safe.
   */
  appendBatch(events: StoredAuditEvent[]): Promise<AppendResult>;
  query(query: AuditQuery): Promise<StoredAuditEvent[]>;
  /** All events of one trace, oldest first. */
  getTrace(traceId: string, options?: { workspaceId?: string; limit?: number }): Promise<StoredAuditEvent[]>;
  aggregate(query: AuditAggregateQuery): Promise<AuditAggregateRow[]>;
  /** Most recently ingested event of a workspace, to continue its hash chain; null if none. */
  getChainHead(workspaceId: string): Promise<ChainHead | null>;
  /** Throws if the backing service is unreachable. */
  ping(): Promise<void>;
  close(): Promise<void>;
}
