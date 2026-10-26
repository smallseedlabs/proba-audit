import { afterEach, describe, expect, it } from 'vitest';
import { verifyAnchorSignature, type ChainAnchorClaim } from '../domain/anchor.js';
import type { AnchorStore } from '../ports/anchor-store.js';
import { uniqueName } from './fixtures.js';

export interface AnchorStoreHarness {
  store: AnchorStore;
  /** The HMAC key the store signs with, so the contract can check signatures. */
  hmacKey: string;
  cleanup?: () => Promise<void>;
}

export function runAnchorStoreContract(name: string, factory: () => Promise<AnchorStoreHarness>): void {
  describe(`AnchorStore contract: ${name}`, () => {
    const harnesses: AnchorStoreHarness[] = [];
    const create = async (): Promise<AnchorStoreHarness> => {
      const h = await factory();
      harnesses.push(h);
      return h;
    };
    afterEach(async () => {
      while (harnesses.length) {
        const h = harnesses.pop()!;
        await h.store.close();
        await h.cleanup?.();
      }
    });
    const claim = (workspaceId: string, count: number, extra: Partial<ChainAnchorClaim> = {}): ChainAnchorClaim => ({
      workspaceId,
      headHash: `${count}`.padStart(64, 'a'),
      count,
      timestamp: `2026-10-25T10:00:${String(count).padStart(2, '0')}.000Z`,
      ...extra,
    });

    it('pings', async () => {
      await expect((await create()).store.ping()).resolves.toBeUndefined();
    });

    it('returns null for a workspace without an anchor', async () => {
      expect(await (await create()).store.get(uniqueName('ws'))).toBeNull();
    });

    it('stores a signed anchor and returns it', async () => {
      const { store, hmacKey } = await create();
      const ws = uniqueName('ws');
      const put = await store.put(claim(ws, 3));
      expect(put).toMatchObject(claim(ws, 3));
      expect(verifyAnchorSignature(hmacKey, put)).toBe(true);
      expect(await store.get(ws)).toEqual(put);
    });

    it('replaces the anchor with a longer chain', async () => {
      const { store } = await create();
      const ws = uniqueName('ws');
      await store.put(claim(ws, 3));
      const next = await store.put(claim(ws, 5));
      expect(next.count).toBe(5);
      expect((await store.get(ws))?.count).toBe(5);
    });

    it('never goes backwards: a shorter chain does not replace the anchor', async () => {
      const { store } = await create();
      const ws = uniqueName('ws');
      const longer = await store.put(claim(ws, 5));
      const result = await store.put(claim(ws, 2));
      expect(result).toEqual(longer);
      expect(await store.get(ws)).toEqual(longer);
    });

    it('keeps workspaces apart', async () => {
      const { store } = await create();
      const a = uniqueName('ws');
      const b = uniqueName('ws');
      await store.put(claim(a, 4));
      await store.put(claim(b, 7));
      expect((await store.get(a))?.count).toBe(4);
      expect((await store.get(b))?.count).toBe(7);
    });
  });
}
