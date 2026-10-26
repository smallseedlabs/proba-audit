import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { AuditContentStore, StoredAuditContent } from '../ports/audit-content-store.js';
import { randomHash, uniqueName } from './fixtures.js';

export interface AuditContentStoreHarness {
  store: AuditContentStore;
  cleanup?: () => Promise<void>;
}

/** Contract any AuditContentStore adapter must satisfy. Each test uses its own workspaceId. */
export function runAuditContentStoreContract(name: string, factory: () => Promise<AuditContentStoreHarness>): void {
  describe(`AuditContentStore contract: ${name}`, () => {
    const harnesses: AuditContentStoreHarness[] = [];
    async function create(): Promise<AuditContentStore> {
      const h = await factory();
      harnesses.push(h);
      return h.store;
    }
    afterEach(async () => {
      while (harnesses.length) {
        const h = harnesses.pop()!;
        await h.store.close();
        await h.cleanup?.();
      }
    });

    const item = (workspaceId: string, overrides: Partial<StoredAuditContent> = {}): StoredAuditContent => ({
      workspaceId,
      eventId: randomUUID(),
      occurredAt: '2026-10-25T10:00:00.000Z',
      content: { kind: 'user_message', text: 'Pause the campaign \u{1F600} "quoted"\nnew line', truncated: false, originalLength: 36, redactions: 0 },
      contentDigest: randomHash(),
      ...overrides,
    });

    it('pings', async () => {
      await expect((await create()).ping()).resolves.toBeUndefined();
    });

    it('stores text and reads it back unchanged, by event and in bulk', async () => {
      const store = await create();
      const ws = uniqueName('ws');
      const a = item(ws);
      const b = item(ws, { content: { kind: 'brain_reply', text: 'x'.repeat(5000), truncated: true, originalLength: 20000, redactions: 3 } });
      await store.put([a, b]);
      expect(await store.get(ws, a.eventId)).toEqual(a);
      const many = await store.getMany(ws, [a.eventId, b.eventId, randomUUID()]);
      expect(many.sort((x, y) => x.eventId.localeCompare(y.eventId))).toEqual([a, b].sort((x, y) => x.eventId.localeCompare(y.eventId)));
    });

    it('keeps workspaces apart and returns nothing for unknown events', async () => {
      const store = await create();
      const ws = uniqueName('ws');
      const a = item(ws);
      await store.put([a]);
      expect(await store.get(uniqueName('other'), a.eventId)).toBeNull();
      expect(await store.get(ws, randomUUID())).toBeNull();
      expect(await store.getMany(ws, [])).toEqual([]);
    });

    it('is idempotent: putting the same event twice reads back one row', async () => {
      const store = await create();
      const ws = uniqueName('ws');
      const a = item(ws);
      await store.put([a]);
      await store.put([a]);
      expect(await store.getMany(ws, [a.eventId])).toEqual([a]);
    });
  });
}
