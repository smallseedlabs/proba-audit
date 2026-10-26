import type { AuditContentStore, StoredAuditContent } from '@smallseedlabs/proba-audit-core';

/** In-process AuditContentStore, for tests and throwaway local runs. */
export class InMemoryAuditContentStore implements AuditContentStore {
  private readonly rows = new Map<string, StoredAuditContent>();

  private static key(workspaceId: string, eventId: string): string {
    return `${workspaceId}\u0000${eventId}`;
  }

  async put(items: StoredAuditContent[]): Promise<void> {
    for (const item of items) this.rows.set(InMemoryAuditContentStore.key(item.workspaceId, item.eventId), structuredClone(item));
  }

  async get(workspaceId: string, eventId: string): Promise<StoredAuditContent | null> {
    const row = this.rows.get(InMemoryAuditContentStore.key(workspaceId, eventId));
    return row ? structuredClone(row) : null;
  }

  async getMany(workspaceId: string, eventIds: string[]): Promise<StoredAuditContent[]> {
    const out: StoredAuditContent[] = [];
    for (const id of new Set(eventIds)) {
      const row = this.rows.get(InMemoryAuditContentStore.key(workspaceId, id));
      if (row) out.push(structuredClone(row));
    }
    return out;
  }

  /** Test helper: remove a row, like a retention job would. */
  delete(workspaceId: string, eventId: string): void {
    this.rows.delete(InMemoryAuditContentStore.key(workspaceId, eventId));
  }

  /** Test helper: replace the stored text, like an attacker with write access would. */
  tamper(workspaceId: string, eventId: string, text: string): void {
    const row = this.rows.get(InMemoryAuditContentStore.key(workspaceId, eventId));
    if (row) row.content = { ...row.content, text };
  }

  async ping(): Promise<void> {
    // Always reachable.
  }

  async close(): Promise<void> {
    // Nothing to release.
  }
}
