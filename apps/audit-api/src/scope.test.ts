import { describe, expect, it, vi } from 'vitest';
import { MemoryLogger, type AccessContext, type PlatformConnector } from '@smallseedlabs/proba-audit-core';
import { ManualClock } from '@smallseedlabs/proba-audit-adapters';
import { createConnectorScope, createStaticScope } from './scope.js';

const ctx = (workspaceId: string): AccessContext => ({ workspaceId, userId: '00000000-0000-4000-8000-000000000001', actor: { type: 'user', id: 'u' } }) as AccessContext;
const connector = (accounts: string[]): PlatformConnector & { calls: number } => {
  const c = { calls: 0, listAccounts: vi.fn(async () => { c.calls += 1; return accounts.map((accountId) => ({ accountId })); }) };
  return c as unknown as PlatformConnector & { calls: number };
};

describe('scope sources', () => {
  it('static: the configured accounts for the configured workspace only', async () => {
    const s = createStaticScope('ws', [{ platform: 'meta', accountId: 'act_1' }]);
    expect(await s.resolve(ctx('ws'))).toEqual({ workspaceId: 'ws', accounts: [{ platform: 'meta', accountId: 'act_1' }] });
    expect(await s.resolve(ctx('other'))).toEqual({ workspaceId: 'other', accounts: [] });
  });

  it('connectors: lists accounts from every platform, caches them and gives other workspaces nothing', async () => {
    const meta = connector(['act_1']);
    const google = connector(['g_1', 'g_2']);
    const clock = new ManualClock();
    const s = createConnectorScope('ws', new Map([['meta', meta], ['google', google]]), { cacheMs: 1000, clock, logger: new MemoryLogger() });
    const scope = await s.resolve(ctx('ws'));
    expect(scope.accounts).toEqual([{ platform: 'meta', accountId: 'act_1' }, { platform: 'google', accountId: 'g_1' }, { platform: 'google', accountId: 'g_2' }]);
    await s.resolve(ctx('ws'));
    expect(meta.calls).toBe(1);
    clock.advance(1500);
    await s.resolve(ctx('ws'));
    expect(meta.calls).toBe(2);
    expect((await s.resolve(ctx('other'))).accounts).toEqual([]);
  });

  it('connectors: one platform failing does not blank the others, and the last good answer is kept', async () => {
    const good = connector(['act_1']);
    const bad = { listAccounts: vi.fn(async () => { throw new Error('down'); }) } as unknown as PlatformConnector;
    const logger = new MemoryLogger();
    const s = createConnectorScope('ws', new Map([['meta', good], ['google', bad]]), { cacheMs: 1000, clock: new ManualClock(), logger });
    expect((await s.resolve(ctx('ws'))).accounts).toEqual([{ platform: 'meta', accountId: 'act_1' }]);
    expect(logger.records.some((r) => r.level === 'error')).toBe(true);
  });
});
