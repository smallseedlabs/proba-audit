/**
 * CheckpointStore port: where a background process remembers how far it got, so
 * a restart (or a crash) resumes from the last successful point.
 *
 * A checkpoint is written only AFTER the work it describes is durable. A crash
 * in between replays that work, which is safe because every write is idempotent.
 */

export interface CheckpointKey {
  workspaceId: string;
  /** Who produced the data: a platform id (`meta`) or a process (`rollup`). */
  source: string;
  /** Account id, or `*` when the checkpoint is not per account. */
  accountId: string;
  /** Sub-stream, for example the granularity (`hour`). */
  stream: string;
}

export interface Checkpoint extends CheckpointKey {
  /** Opaque resume token (a connector cursor, or a watermark). */
  cursor: string;
  /** Run (trace) id that wrote it. */
  runId: string;
  /** UTC ISO 8601 with trailing Z. */
  updatedAt: string;
}

export interface CheckpointStore {
  get(key: CheckpointKey): Promise<Checkpoint | null>;
  /** Store the checkpoint, replacing the previous one for the key. */
  set(key: CheckpointKey, value: { cursor: string; runId: string }): Promise<Checkpoint>;
  delete(key: CheckpointKey): Promise<void>;
  /** Throws if the backing service is unreachable. */
  ping(): Promise<void>;
  close(): Promise<void>;
}
