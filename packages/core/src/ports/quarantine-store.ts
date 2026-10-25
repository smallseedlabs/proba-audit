/**
 * QuarantineStore port: the dead-letter table for ingested observations that
 * failed validation. Nothing that lands here reaches the metrics tables; it is
 * kept with the reason so it can be inspected, fixed upstream and re-pulled.
 */

export interface QuarantinedObservation {
  quarantineId: string;
  workspaceId: string;
  platform: string;
  accountId: string;
  /** Sync run (trace) id. */
  runId: string;
  /** Short machine-readable reason, for example `schema_invalid` or `platform_mismatch`. */
  reason: string;
  /** Validation issues (path and message only; never values). */
  issues: { path: string; message: string }[];
  /** The raw payload as received, JSON-serialised. May contain whatever the connector returned. */
  payload: string;
  /** UTC ISO 8601 with trailing Z. */
  quarantinedAt: string;
}

export interface QuarantineQuery {
  workspaceId?: string;
  platform?: string;
  accountId?: string;
  runId?: string;
  limit?: number;
}

export interface QuarantineStore {
  add(entries: QuarantinedObservation[]): Promise<void>;
  list(query?: QuarantineQuery): Promise<QuarantinedObservation[]>;
  ping(): Promise<void>;
  close(): Promise<void>;
}
