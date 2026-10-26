import type { Clock, LeaseStore } from '@smallseedlabs/proba-audit-core';

/**
 * In-process LeaseStore. Leases are only visible inside this object: instances that share one object (tests of two
 * replicas) exclude each other, separate processes do not. For tests and a single local process; refused in production.
 */
export class InMemoryLeaseStore implements LeaseStore {
  private readonly held = new Map<string, { ownerId: string; until: number }>();

  constructor(private readonly clock: { now(): Date } | Clock = { now: () => new Date() }) {}

  private live(key: string): { ownerId: string; until: number } | undefined {
    const lease = this.held.get(key);
    if (lease && lease.until > this.clock.now().getTime()) return lease;
    if (lease) this.held.delete(key);
    return undefined;
  }

  async tryAcquire(key: string, ownerId: string, ttlMs: number): Promise<boolean> {
    if (this.live(key)) return false;
    this.held.set(key, { ownerId, until: this.clock.now().getTime() + ttlMs });
    return true;
  }

  async release(key: string, ownerId: string): Promise<boolean> {
    const lease = this.live(key);
    if (!lease || lease.ownerId !== ownerId) return false;
    this.held.delete(key);
    return true;
  }

  async renew(key: string, ownerId: string, ttlMs: number): Promise<boolean> {
    const lease = this.live(key);
    if (!lease || lease.ownerId !== ownerId) return false;
    lease.until = this.clock.now().getTime() + ttlMs;
    return true;
  }

  async ping(): Promise<void> {
    // Always reachable.
  }

  async close(): Promise<void> {
    // Nothing to release.
  }
}
