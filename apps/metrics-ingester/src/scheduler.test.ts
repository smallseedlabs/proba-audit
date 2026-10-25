import { afterEach, describe, expect, it } from 'vitest';
import { ManualClock } from '@smallseedlabs/proba-audit-adapters';
import { makeHarness, type Harness } from './harness.testing.js';
import { LeaseTable, nextDelayMs } from './scheduler.js';

const open: Harness[] = [];
afterEach(async () => {
  while (open.length) await open.pop()!.scheduler.stop();
});
const harness = (...args: Parameters<typeof makeHarness>) => {
  const h = makeHarness(...args);
  open.push(h);
  return h;
};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await wait(5);
  }
}

describe('nextDelayMs', () => {
  const base = { intervalMs: 60_000, jitterRatio: 0.1, failures: 0, failureBackoffMaxMs: 600_000 };

  it('spreads the interval by +/- jitter', () => {
    expect(nextDelayMs({ ...base, random: () => 0 })).toBe(54_000);
    expect(nextDelayMs({ ...base, random: () => 0.5 })).toBe(60_000);
    expect(nextDelayMs({ ...base, random: () => 1 })).toBe(66_000);
  });

  it('grows exponentially after failures, up to the cap', () => {
    const d = (failures: number) => nextDelayMs({ ...base, failures, random: () => 0.5 });
    expect([d(1), d(2), d(3)]).toEqual([120_000, 240_000, 480_000]);
    expect(d(4)).toBe(600_000);
    expect(d(50)).toBe(600_000);
  });

  it('never comes back earlier than the platform asked', () => {
    expect(nextDelayMs({ ...base, random: () => 0.5, retryAfterMs: 300_000 })).toBe(300_000);
  });

  it('is at least 1 ms even with zero interval and jitter', () => {
    expect(nextDelayMs({ ...base, intervalMs: 0, random: () => 0.5 })).toBe(1);
  });
});

describe('LeaseTable', () => {
  it('allows one holder per key until release or expiry', () => {
    const clock = new ManualClock();
    const t = new LeaseTable(clock);
    expect(t.tryAcquire('a', 1000)).toBe(true);
    expect(t.tryAcquire('a', 1000)).toBe(false);
    expect(t.tryAcquire('b', 1000)).toBe(true);
    t.release('a');
    expect(t.tryAcquire('a', 1000)).toBe(true);
    clock.advance(1001);
    expect(t.isHeld('a')).toBe(false);
    expect(t.tryAcquire('a', 1000)).toBe(true); // expired lease can be taken over
  });
});

describe('IngestScheduler', () => {
  it('discovers every account of every connector', async () => {
    const h = harness();
    await h.scheduler.refreshAccounts();
    expect(h.scheduler.taskIds()).toEqual(['meta:stub_meta_acct_1', 'meta:stub_meta_acct_2', 'meta:stub_meta_acct_3']);
  });

  it('uses the per-platform interval override', () => {
    const h = harness({ scheduler: { intervalOverridesMs: { meta: 1234 } } });
    expect(h.scheduler.intervalFor('meta')).toBe(1234);
    expect(h.scheduler.intervalFor('google')).toBe(60_000);
  });

  it('does not run the same account twice at once (overlap protection)', async () => {
    const h = harness();
    await h.scheduler.refreshAccounts();
    const [a, b] = await Promise.all([h.scheduler.syncNow('meta', 'stub_meta_acct_1'), h.scheduler.syncNow('meta', 'stub_meta_acct_1')]);
    expect([a, b].filter((o) => o === null)).toHaveLength(1);
    expect([a, b].filter((o) => o?.status === 'completed')).toHaveLength(1);
    expect(h.logger.records.some((r) => r.fields.lifecycle === 'sync_skipped_overlap')).toBe(true);
    // The lease is released afterwards.
    expect(await h.scheduler.syncNow('meta', 'stub_meta_acct_1')).not.toBeNull();
  });

  it('different accounts run side by side', async () => {
    const h = harness();
    await h.scheduler.refreshAccounts();
    const outcomes = await Promise.all(['1', '2', '3'].map((n) => h.scheduler.syncNow('meta', `stub_meta_acct_${n}`)));
    expect(outcomes.every((o) => o?.status === 'completed')).toBe(true);
  });

  it('loops on its interval, honours failures, and stop() waits for the run in flight', async () => {
    const h = harness({ scheduler: { intervalMs: 20, jitterRatio: 0, failureBackoffMaxMs: 40, accountRefreshMs: 60_000 } });
    await h.scheduler.start();
    await until(() => h.emitter.actions().filter((a) => a === 'metrics.fetch_completed').length >= 6); // 3 accounts x 2 runs
    h.connector.injectFault({ kind: 'auth' }, 100);
    await until(() => h.emitter.actions().includes('metrics.fetch_failed'));
    await h.scheduler.stop();
    const total = h.emitter.actions().length;
    await wait(80);
    expect(h.emitter.actions()).toHaveLength(total); // nothing runs after stop
    // Every started run finished (completed or failed): none was cut off.
    const a = h.emitter.actions();
    expect(a.filter((x) => x === 'metrics.fetch_started').length).toBe(a.filter((x) => x === 'metrics.fetch_completed' || x === 'metrics.fetch_failed').length);
  });

  it('picks up accounts that appear later and drops accounts that disappear', async () => {
    const h = harness({ scheduler: { intervalMs: 60_000 } });
    let accounts = [{ accountId: 'a1' }];
    h.connector.listAccounts = async () => accounts;
    await h.scheduler.refreshAccounts();
    expect(h.scheduler.taskIds()).toEqual(['meta:a1']);
    accounts = [{ accountId: 'a1' }, { accountId: 'a2' }];
    await h.scheduler.refreshAccounts();
    expect(h.scheduler.taskIds()).toEqual(['meta:a1', 'meta:a2']);
    accounts = [{ accountId: 'a2' }];
    await h.scheduler.refreshAccounts();
    expect(h.scheduler.taskIds()).toEqual(['meta:a2']);
  });

  it('keeps existing accounts when listing fails', async () => {
    const h = harness();
    await h.scheduler.refreshAccounts();
    h.connector.listAccounts = async () => {
      throw new Error('platform down');
    };
    await h.scheduler.refreshAccounts();
    expect(h.scheduler.taskIds()).toHaveLength(3);
    expect(h.logger.records.some((r) => r.fields.lifecycle === 'accounts_failed')).toBe(true);
  });
});
