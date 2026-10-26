/**
 * LeaseStore port: a short-lived, named exclusive claim ("lease") that works across processes.
 *
 * It answers "may I do this now?" for work that must not run twice at the same time: one sync per ad account
 * (metrics-ingester), one rollup run per workspace (rollup), one writer per workspace chain (audit-consumer).
 * With the in-memory adapter that holds inside one process only; with a shared backend (Redis) it holds across replicas.
 *
 * Rules every adapter follows (`runLeaseStoreContract`):
 * - `tryAcquire` never waits and is NOT re-entrant: while a lease is live, every caller gets `false`, the owner included.
 * - A lease expires by itself `ttlMs` after it was acquired (or last renewed), so a crashed or hung owner cannot block the key for ever.
 * - Only the owner can release or renew: a release or renew by another `ownerId`, or after the lease expired and was taken
 *   by someone else, changes nothing and returns `false`.
 */
export interface LeaseStore {
  /** Take the lease if nobody holds a live one. Returns whether this owner now holds it. Never waits. */
  tryAcquire(key: string, ownerId: string, ttlMs: number): Promise<boolean>;
  /** Give the lease back. Only the owner can: returns false when it is held by someone else or already expired. */
  release(key: string, ownerId: string): Promise<boolean>;
  /**
   * Extend a lease the owner still holds to `ttlMs` from now. Returns false when the lease was lost (expired, taken over): the
   * caller must stop the work the lease protected. Optional: callers whose work is shorter than the ttl never call it.
   */
  renew?(key: string, ownerId: string, ttlMs: number): Promise<boolean>;
  /** Throws if the backing service is unreachable. */
  ping(): Promise<void>;
  close(): Promise<void>;
}

/** The lease for `key` is held by someone else, so the work was not started. Callers retry later. */
export class LeaseHeldError extends Error {
  constructor(readonly key: string) {
    super(`The lease ${key} is held by another instance`);
    this.name = 'LeaseHeldError';
  }
}

/** A lease the work depended on was lost (expired or taken over) before the work finished; the work must not go on. */
export class LeaseLostError extends Error {
  constructor(readonly key: string) {
    super(`The lease ${key} was lost before the work finished`);
    this.name = 'LeaseLostError';
  }
}
