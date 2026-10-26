import { afterEach, describe, expect, it } from 'vitest';
import type { LeaseStore } from '../ports/lease-store.js';
import { uniqueName } from './fixtures.js';

export interface LeaseStoreHarness {
  store: LeaseStore;
  /** A second instance on the same backing service: another process (replica) sharing the leases. */
  peer: LeaseStore;
  cleanup?: () => Promise<void>;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Expiry is real time (the Redis adapter cannot be driven by a fake clock), so the contract uses short ttls. */
export function runLeaseStoreContract(name: string, factory: () => Promise<LeaseStoreHarness>): void {
  describe(`LeaseStore contract: ${name}`, () => {
    const harnesses: LeaseStoreHarness[] = [];
    const create = async (): Promise<LeaseStoreHarness> => {
      const h = await factory();
      harnesses.push(h);
      return h;
    };
    afterEach(async () => {
      while (harnesses.length) {
        const h = harnesses.pop()!;
        await h.store.close();
        await h.peer.close();
        await h.cleanup?.();
      }
    });
    const LONG = 30_000;
    const SHORT = 80;

    it('pings', async () => {
      const { store, peer } = await create();
      await expect(store.ping()).resolves.toBeUndefined();
      await expect(peer.ping()).resolves.toBeUndefined();
    });

    it('grants a free lease and refuses it to everyone else, the owner included', async () => {
      const { store, peer } = await create();
      const key = uniqueName('lease');
      expect(await store.tryAcquire(key, 'owner-a', LONG)).toBe(true);
      expect(await store.tryAcquire(key, 'owner-a', LONG)).toBe(false); // not re-entrant
      expect(await store.tryAcquire(key, 'owner-b', LONG)).toBe(false);
      expect(await peer.tryAcquire(key, 'owner-b', LONG)).toBe(false); // across instances
    });

    it('keeps keys apart', async () => {
      const { store } = await create();
      expect(await store.tryAcquire(uniqueName('lease'), 'owner-a', LONG)).toBe(true);
      expect(await store.tryAcquire(uniqueName('lease'), 'owner-a', LONG)).toBe(true);
    });

    it('is released by its owner, and then free for anyone', async () => {
      const { store, peer } = await create();
      const key = uniqueName('lease');
      await store.tryAcquire(key, 'owner-a', LONG);
      expect(await store.release(key, 'owner-a')).toBe(true);
      expect(await peer.tryAcquire(key, 'owner-b', LONG)).toBe(true);
    });

    it('is not released by anyone but the owner', async () => {
      const { store, peer } = await create();
      const key = uniqueName('lease');
      await store.tryAcquire(key, 'owner-a', LONG);
      expect(await peer.release(key, 'owner-b')).toBe(false);
      expect(await store.tryAcquire(key, 'owner-b', LONG)).toBe(false); // still held by owner-a
      expect(await store.release(uniqueName('never-held'), 'owner-a')).toBe(false);
    });

    it('expires by itself, and an expired lease can be taken over', async () => {
      const { store, peer } = await create();
      const key = uniqueName('lease');
      expect(await store.tryAcquire(key, 'owner-a', SHORT)).toBe(true);
      await sleep(SHORT * 3);
      expect(await peer.tryAcquire(key, 'owner-b', LONG)).toBe(true);
    });

    it('the old owner cannot release a lease that was taken over', async () => {
      const { store, peer } = await create();
      const key = uniqueName('lease');
      await store.tryAcquire(key, 'owner-a', SHORT);
      await sleep(SHORT * 3);
      await peer.tryAcquire(key, 'owner-b', LONG);
      expect(await store.release(key, 'owner-a')).toBe(false);
      expect(await store.tryAcquire(key, 'owner-a', LONG)).toBe(false); // owner-b still holds it
    });

    it('lets only one of many concurrent callers win', async () => {
      const { store, peer } = await create();
      const key = uniqueName('lease');
      const results = await Promise.all(
        Array.from({ length: 10 }, (_, i) => (i % 2 === 0 ? store : peer).tryAcquire(key, `owner-${i}`, LONG))
      );
      expect(results.filter(Boolean)).toHaveLength(1);
    });

    it('renews (when supported): the owner extends its lease, others cannot', async () => {
      const { store, peer } = await create();
      if (!store.renew || !peer.renew) return; // optional in the port
      const key = uniqueName('lease');
      await store.tryAcquire(key, 'owner-a', SHORT * 2);
      expect(await peer.renew(key, 'owner-b', LONG)).toBe(false);
      expect(await store.renew(key, 'owner-a', LONG)).toBe(true);
      await sleep(SHORT * 4);
      expect(await peer.tryAcquire(key, 'owner-b', LONG)).toBe(false); // the renewal outlived the first ttl
    });

    it('does not renew a lease that expired or was never held (when supported)', async () => {
      const { store, peer } = await create();
      if (!store.renew || !peer.renew) return;
      const key = uniqueName('lease');
      expect(await store.renew(uniqueName('never-held'), 'owner-a', LONG)).toBe(false);
      await store.tryAcquire(key, 'owner-a', SHORT);
      await sleep(SHORT * 3);
      expect(await store.renew(key, 'owner-a', LONG)).toBe(false);
      await peer.tryAcquire(key, 'owner-b', LONG);
      expect(await store.renew(key, 'owner-a', LONG)).toBe(false);
    });
  });
}
