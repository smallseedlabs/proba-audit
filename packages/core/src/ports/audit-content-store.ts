/**
 * AuditContentStore port: the raw text of audit events (AuditEvent.content), kept apart from the
 * events themselves so it can have its own retention and permissions. The event row only holds a
 * digest of the text (StoredAuditEvent.contentDigest), which the hash chain covers.
 *
 * Writes are idempotent: putting the same (workspaceId, eventId) again replaces nothing that matters
 * (same event, same text). Nothing is ever updated by the services; retention may delete.
 */

import type { AuditContent } from '@smallseedlabs/proba-protocol/audit';

export type { AuditContent } from '@smallseedlabs/proba-protocol/audit';

export interface StoredAuditContent {
  workspaceId: string;
  eventId: string;
  /** The event's occurredAt (UTC ISO 8601, Z): partitions the storage, so retention can drop whole months. */
  occurredAt: string;
  content: AuditContent;
  /** SHA-256 hex of canonicalizeAuditContent(content): equals the event's `contentDigest`. */
  contentDigest: string;
}

export interface AuditContentStore {
  /** Store (or re-store) content rows. Idempotent. */
  put(items: StoredAuditContent[]): Promise<void>;
  /** The content of one event of `workspaceId`, or null (never stored, dropped, or deleted by retention). */
  get(workspaceId: string, eventId: string): Promise<StoredAuditContent | null>;
  /** The content of several events of `workspaceId`; events without content are simply absent. */
  getMany(workspaceId: string, eventIds: string[]): Promise<StoredAuditContent[]>;
  /** Throws if the backing service is unreachable. */
  ping(): Promise<void>;
  close(): Promise<void>;
}
