import type { QuarantinedObservation, QuarantineQuery, QuarantineStore } from '@smallseedlabs/proba-audit-core';

/** In-process QuarantineStore, for tests and throwaway local runs. */
export class InMemoryQuarantineStore implements QuarantineStore {
  private readonly rows: QuarantinedObservation[] = [];

  async add(entries: QuarantinedObservation[]): Promise<void> {
    for (const e of entries) this.rows.push(structuredClone(e));
  }

  async list(query: QuarantineQuery = {}): Promise<QuarantinedObservation[]> {
    return this.rows
      .filter(
        (r) =>
          (query.workspaceId === undefined || r.workspaceId === query.workspaceId) &&
          (query.platform === undefined || r.platform === query.platform) &&
          (query.accountId === undefined || r.accountId === query.accountId) &&
          (query.runId === undefined || r.runId === query.runId)
      )
      .sort((a, b) => b.quarantinedAt.localeCompare(a.quarantinedAt) || a.quarantineId.localeCompare(b.quarantineId))
      .slice(0, query.limit ?? 100)
      .map((r) => structuredClone(r));
  }

  async ping(): Promise<void> {
    // Always reachable.
  }

  async close(): Promise<void> {
    // Nothing to release.
  }
}
