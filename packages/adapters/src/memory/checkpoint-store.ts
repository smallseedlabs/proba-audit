import type { Checkpoint, CheckpointKey, CheckpointStore, Clock } from '@smallseedlabs/proba-audit-core';
import { SystemClock } from '../runtime/system.js';

const idOf = (k: CheckpointKey): string => [k.workspaceId, k.source, k.accountId, k.stream].join('\u0000');

/** In-process CheckpointStore. Lost on restart: for tests and throwaway local runs. */
export class InMemoryCheckpointStore implements CheckpointStore {
  private readonly rows = new Map<string, Checkpoint>();

  constructor(private readonly clock: Clock = new SystemClock()) {}

  async get(key: CheckpointKey): Promise<Checkpoint | null> {
    const row = this.rows.get(idOf(key));
    return row ? { ...row } : null;
  }

  async set(key: CheckpointKey, value: { cursor: string; runId: string }): Promise<Checkpoint> {
    const row: Checkpoint = {
      workspaceId: key.workspaceId,
      source: key.source,
      accountId: key.accountId,
      stream: key.stream,
      cursor: value.cursor,
      runId: value.runId,
      updatedAt: this.clock.isoNow(),
    };
    this.rows.set(idOf(key), row);
    return { ...row };
  }

  async delete(key: CheckpointKey): Promise<void> {
    this.rows.delete(idOf(key));
  }

  async ping(): Promise<void> {
    // Always reachable.
  }

  async close(): Promise<void> {
    // Nothing to release.
  }
}
