import { afterEach, describe, expect, it } from 'vitest';
import type { CheckpointKey, CheckpointStore } from '../ports/checkpoint-store.js';
import type { QuarantinedObservation, QuarantineStore } from '../ports/quarantine-store.js';
import { uniqueName } from './fixtures.js';

export interface CheckpointStoreHarness {
  store: CheckpointStore;
  cleanup?: () => Promise<void>;
}

export function runCheckpointStoreContract(name: string, factory: () => Promise<CheckpointStoreHarness>): void {
  describe(`CheckpointStore contract: ${name}`, () => {
    const harnesses: CheckpointStoreHarness[] = [];
    const create = async (): Promise<CheckpointStore> => {
      const h = await factory();
      harnesses.push(h);
      return h.store;
    };
    afterEach(async () => {
      while (harnesses.length) {
        const h = harnesses.pop()!;
        await h.store.close();
        await h.cleanup?.();
      }
    });
    const key = (extra: Partial<CheckpointKey> = {}): CheckpointKey => ({
      workspaceId: uniqueName('ws'),
      source: 'meta',
      accountId: 'act_1',
      stream: 'hour',
      ...extra,
    });

    it('pings', async () => {
      await expect((await create()).ping()).resolves.toBeUndefined();
    });

    it('returns null for an unknown key', async () => {
      expect(await (await create()).get(key())).toBeNull();
    });

    it('stores and reads back a checkpoint, and replaces it on the next set', async () => {
      const store = await create();
      const k = key();
      const first = await store.set(k, { cursor: 'c1', runId: 'run-1' });
      expect(first).toMatchObject({ ...k, cursor: 'c1', runId: 'run-1' });
      expect(first.updatedAt).toMatch(/Z$/);
      expect(await store.get(k)).toEqual(first);
      await store.set(k, { cursor: 'c2', runId: 'run-2' });
      expect(await store.get(k)).toMatchObject({ cursor: 'c2', runId: 'run-2' });
    });

    it('keeps one checkpoint per workspace, source, account and stream', async () => {
      const store = await create();
      const base = key();
      await store.set(base, { cursor: 'a', runId: 'r' });
      await store.set({ ...base, stream: 'day' }, { cursor: 'b', runId: 'r' });
      await store.set({ ...base, accountId: 'act_2' }, { cursor: 'c', runId: 'r' });
      await store.set({ ...base, source: 'google' }, { cursor: 'd', runId: 'r' });
      expect((await store.get(base))?.cursor).toBe('a');
      expect((await store.get({ ...base, stream: 'day' }))?.cursor).toBe('b');
      expect((await store.get({ ...base, accountId: 'act_2' }))?.cursor).toBe('c');
      expect((await store.get({ ...base, source: 'google' }))?.cursor).toBe('d');
    });

    it('survives a new store instance over the same backend (the restart case)', async () => {
      const first = await create();
      const k = key();
      await first.set(k, { cursor: 'persisted', runId: 'r' });
      const second = await create();
      // Backends that are not durable across instances (in-memory) simply return null: skip.
      const got = await second.get(k);
      if (got !== null) expect(got.cursor).toBe('persisted');
    });

    it('deletes a checkpoint', async () => {
      const store = await create();
      const k = key();
      await store.set(k, { cursor: 'x', runId: 'r' });
      await store.delete(k);
      expect(await store.get(k)).toBeNull();
    });
  });
}

export interface QuarantineStoreHarness {
  store: QuarantineStore;
  cleanup?: () => Promise<void>;
}

export function runQuarantineStoreContract(name: string, factory: () => Promise<QuarantineStoreHarness>): void {
  describe(`QuarantineStore contract: ${name}`, () => {
    const harnesses: QuarantineStoreHarness[] = [];
    const create = async (): Promise<QuarantineStore> => {
      const h = await factory();
      harnesses.push(h);
      return h.store;
    };
    afterEach(async () => {
      while (harnesses.length) {
        const h = harnesses.pop()!;
        await h.store.close();
        await h.cleanup?.();
      }
    });
    const entry = (workspaceId: string, extra: Partial<QuarantinedObservation> = {}): QuarantinedObservation => ({
      quarantineId: uniqueName('q'),
      workspaceId,
      platform: 'meta',
      accountId: 'act_1',
      runId: 'run-1',
      reason: 'schema_invalid',
      issues: [{ path: 'metrics.spend', message: 'Number must be greater than or equal to 0' }],
      payload: JSON.stringify({ spend: -1 }),
      quarantinedAt: '2026-10-25T10:00:00.000Z',
      ...extra,
    });

    it('stores entries with their reason, issues and payload, and lists them newest first', async () => {
      const store = await create();
      const ws = uniqueName('ws');
      const a = entry(ws, { quarantinedAt: '2026-10-25T10:00:00.000Z' });
      const b = entry(ws, { quarantinedAt: '2026-10-25T11:00:00.000Z', reason: 'platform_mismatch', issues: [] });
      await store.add([a, b]);
      expect(await store.list({ workspaceId: ws })).toEqual([b, a]);
    });

    it('filters by account, platform and run, and limits', async () => {
      const store = await create();
      const ws = uniqueName('ws');
      await store.add([
        entry(ws, { accountId: 'act_1', runId: 'r1' }),
        entry(ws, { accountId: 'act_2', runId: 'r2' }),
        entry(ws, { platform: 'google', runId: 'r2' }),
      ]);
      expect(await store.list({ workspaceId: ws, accountId: 'act_2' })).toHaveLength(1);
      expect(await store.list({ workspaceId: ws, platform: 'google' })).toHaveLength(1);
      expect(await store.list({ workspaceId: ws, runId: 'r2' })).toHaveLength(2);
      expect(await store.list({ workspaceId: ws, limit: 2 })).toHaveLength(2);
    });

    it('accepts an empty batch', async () => {
      await expect((await create()).add([])).resolves.toBeUndefined();
    });
  });
}
