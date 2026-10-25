import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ConnectorAuthError,
  ConnectorRequestError,
  RateLimitedError,
  TransientConnectorError,
  type FetchWindow,
  type MetricObservation,
} from '@smallseedlabs/proba-audit-core';
import { runPlatformConnectorContract } from '@smallseedlabs/proba-audit-core/testing';
import { isValidTimeZone, metricObservationSchema } from '@smallseedlabs/proba-protocol/audit';
import { ManualClock } from '../memory/clock-ids.js';
import {
  STUB_SOURCE_REF_PREFIX,
  StubConnectorNotAllowedError,
  StubPlatformConnector,
  assertStubConnectorAllowed,
} from './stub-platform-connector.js';

const HOUR = 3_600_000;
const START = '2026-10-28T12:00:00.000Z';

function make(overrides: Partial<ConstructorParameters<typeof StubPlatformConnector>[0]> = {}, clock = new ManualClock(START)) {
  return { clock, connector: new StubPlatformConnector({ platform: 'meta', clock, nodeEnv: 'test', ...overrides }) };
}

const clockForContract = new ManualClock(START);
runPlatformConnectorContract('StubPlatformConnector', () => new StubPlatformConnector({ platform: 'meta', clock: clockForContract, nodeEnv: 'test' }), {
  now: () => clockForContract.now(),
  advance: (ms) => clockForContract.advance(ms),
});

async function pull(connector: StubPlatformConnector, accountId: string, window: FetchWindow, cursor?: string): Promise<{ observations: MetricObservation[]; cursor: string }> {
  const observations: MetricObservation[] = [];
  let pageToken: string | undefined;
  let next = '';
  do {
    const page = await connector.fetchObservations({ accountId }, { window, cursor, pageToken, pageSize: 1000 });
    observations.push(...page.observations);
    pageToken = page.nextPageToken;
    next = page.nextCursor;
  } while (pageToken);
  return { observations, cursor: next };
}

const hourWindow = (from: string, to: string): FetchWindow => ({ from, to, granularity: 'hour' });
const dayWindow = (from: string, to: string): FetchWindow => ({ from, to, granularity: 'day' });
const sum = (rows: MetricObservation[], pick: (o: MetricObservation) => number) => rows.reduce((t, o) => t + pick(o), 0);

describe('StubPlatformConnector', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('is a development data source: every observation carries a stub: sourceRef and valid protocol fields', async () => {
    const { connector } = make();
    const [account] = await connector.listAccounts();
    const { observations } = await pull(connector, account.accountId, hourWindow('2026-10-27T12:00:00.000Z', START));
    expect(observations).toHaveLength(24 * 8); // 2 campaigns x 2 adsets x 2 ads
    for (const o of observations) {
      expect(metricObservationSchema.safeParse(o).success).toBe(true);
      expect(o.sourceRef?.startsWith(STUB_SOURCE_REF_PREFIX)).toBe(true);
      expect(o.accountId).toMatch(/^stub_meta_/);
    }
  });

  it('is deterministic for a seed and clock, and different for another seed', async () => {
    const a = make();
    const b = make();
    const c = make({ seed: 'another' });
    const window = hourWindow('2026-10-27T00:00:00.000Z', START);
    const [account] = await a.connector.listAccounts();
    const [x, y, z] = await Promise.all([a, b, c].map((s) => pull(s.connector, account.accountId, window)));
    expect(x.observations).toEqual(y.observations);
    expect(x.observations).not.toEqual(z.observations);
  });

  it('serves several accounts with their own timezone and currency', async () => {
    const { connector } = make();
    const accounts = await connector.listAccounts();
    expect(accounts.length).toBeGreaterThanOrEqual(3);
    expect(new Set(accounts.map((a) => a.timezone)).size).toBe(accounts.length);
    for (const a of accounts) {
      expect(isValidTimeZone(a.timezone as string)).toBe(true);
      const { observations } = await pull(connector, a.accountId, hourWindow('2026-10-28T10:00:00.000Z', START));
      for (const o of observations) {
        expect(o.timezone).toBe(a.timezone);
        expect(o.currency).toBe(a.currency);
      }
    }
    expect((await connector.listCampaigns(accounts[1])).length).toBe(3);
  });

  it('only reports complete periods: nothing for the hour that is still running', async () => {
    const { connector } = make({}, new ManualClock('2026-10-28T12:30:00.000Z'));
    const [account] = await connector.listAccounts();
    const { observations } = await pull(connector, account.accountId, hourWindow('2026-10-28T10:00:00.000Z', '2026-10-28T13:00:00.000Z'));
    expect(Math.max(...observations.map((o) => Date.parse(o.periodEnd)))).toBe(Date.parse('2026-10-28T12:00:00.000Z'));
  });

  it('restates a period after it ends: revision +1 every interval, up to the limit, with changed numbers', async () => {
    const { connector, clock } = make({ restateEveryMinutes: 30, restateRevisions: 2 });
    const [account] = await connector.listAccounts();
    const window = hourWindow('2026-10-28T11:00:00.000Z', START);
    const key = (o: MetricObservation) => o.adId as string;
    const at = async () => new Map((await pull(connector, account.accountId, window)).observations.map((o) => [key(o), o]));

    const r0 = await at();
    expect([...r0.values()].every((o) => o.revision === 0)).toBe(true);
    clock.advance(30 * 60_000);
    const r1 = await at();
    expect([...r1.values()].every((o) => o.revision === 1)).toBe(true);
    clock.advance(30 * 60_000);
    const r2 = await at();
    expect([...r2.values()].every((o) => o.revision === 2)).toBe(true);
    clock.advance(10 * HOUR);
    const later = new Map((await pull(connector, account.accountId, window)).observations.map((o) => [key(o), o]));
    expect([...later.values()].every((o) => o.revision === 2)).toBe(true); // final
    expect([...later.values()].map((o) => o.metrics)).toEqual([...r2.values()].map((o) => o.metrics));

    const changed = [...r0.values()].filter((o) => JSON.stringify(o.metrics) !== JSON.stringify(r2.get(key(o))?.metrics));
    expect(changed.length).toBeGreaterThan(0);
    // Late conversions only go up in aggregate.
    expect(sum([...r2.values()], (o) => o.metrics.conversions)).toBeGreaterThan(sum([...r0.values()], (o) => o.metrics.conversions));
    for (const o of r0.values()) expect(o.fetchedAt).toBe(START);
  });

  it('can be told not to restate', async () => {
    const { connector, clock } = make({ restateRevisions: 0 });
    const [account] = await connector.listAccounts();
    expect(connector.capabilities().supportsRestatements).toBe(false);
    const window = hourWindow('2026-10-28T11:00:00.000Z', START);
    const first = await pull(connector, account.accountId, window);
    clock.advance(3 * HOUR);
    const second = await pull(connector, account.accountId, window);
    expect(second.observations.map((o) => o.metrics)).toEqual(first.observations.map((o) => o.metrics));
    expect(second.observations.every((o) => o.revision === 0)).toBe(true);
  });

  it('pulls incrementally by cursor: only new hours and restated hours come back', async () => {
    const { connector, clock } = make({ restateEveryMinutes: 30, restateRevisions: 1 });
    const [account] = await connector.listAccounts();
    const window = (to: string) => hourWindow('2026-10-28T08:00:00.000Z', to);
    const first = await pull(connector, account.accountId, window(START));
    expect(first.cursor).toBe(`stub:${START}`);

    expect((await pull(connector, account.accountId, window(START), first.cursor)).observations).toEqual([]);

    clock.advance(HOUR + 10 * 60_000); // 13:10: hour 12-13 is new, hour 11-12 was restated at 12:30
    const next = await pull(connector, account.accountId, window('2026-10-28T14:00:00.000Z'), first.cursor);
    const starts = new Set(next.observations.map((o) => o.periodStart));
    expect([...starts].sort()).toEqual(['2026-10-28T11:00:00.000Z', '2026-10-28T12:00:00.000Z']);
    expect(next.observations.filter((o) => o.periodStart === '2026-10-28T11:00:00.000Z').every((o) => o.revision === 1)).toBe(true);
    expect(next.observations.filter((o) => o.periodStart === '2026-10-28T12:00:00.000Z').every((o) => o.revision === 0)).toBe(true);
  });

  it('keeps one cursor and a stable snapshot across the pages of one pull, even if time moves on', async () => {
    const { connector, clock } = make();
    const [account] = await connector.listAccounts();
    const window = hourWindow('2026-10-28T00:00:00.000Z', START);
    const p1 = await connector.fetchObservations(account, { window, pageSize: 50 });
    clock.advance(3 * HOUR);
    const p2 = await connector.fetchObservations(account, { window, pageSize: 50, pageToken: p1.nextPageToken });
    expect(p2.nextCursor).toBe(p1.nextCursor);
    expect(p2.observations[0].fetchedAt).toBe(START);
    // Identical to the same page of the same pull made without time passing.
    const still = make();
    const q1 = await still.connector.fetchObservations(account, { window, pageSize: 50 });
    const q2 = await still.connector.fetchObservations(account, { window, pageSize: 50, pageToken: q1.nextPageToken });
    expect(p2.observations).toEqual(q2.observations);
  });

  it('daily rows are local days (23/25 hours around DST) whose numbers equal the sum of their hours', async () => {
    const { connector } = make({ restateRevisions: 0 }, new ManualClock('2026-10-29T12:00:00.000Z'));
    const london = (await connector.listAccounts()).find((a) => a.timezone === 'Europe/London');
    const days = await pull(connector, london!.accountId, dayWindow('2026-10-24T00:00:00.000Z', '2026-10-27T00:00:00.000Z'));
    const day = days.observations.filter((o) => o.periodStart === '2026-10-24T23:00:00.000Z');
    expect(day.length).toBe(8);
    expect(Date.parse(day[0].periodEnd) - Date.parse(day[0].periodStart)).toBe(25 * HOUR); // clocks went back on 25 Oct
    const hours = await pull(connector, london!.accountId, hourWindow('2026-10-24T23:00:00.000Z', '2026-10-26T00:00:00.000Z'));
    expect(hours.observations.length).toBe(25 * 8);
    expect(sum(day, (o) => o.metrics.impressions)).toBe(sum(hours.observations, (o) => o.metrics.impressions));
    expect(sum(day, (o) => o.metrics.clicks)).toBe(sum(hours.observations, (o) => o.metrics.clicks));
    expect(Math.round(sum(day, (o) => o.metrics.spend) * 1e4) / 1e4).toBeCloseTo(sum(hours.observations, (o) => o.metrics.spend), 3);
    // Reach is not additive: the daily figure is below the sum of the hourly ones.
    expect(sum(day, (o) => o.metrics.reach as number)).toBeLessThan(sum(hours.observations, (o) => o.metrics.reach as number));
  });

  it('a day starts at revision 0 when it completes and rises as its hours are restated', async () => {
    const { connector, clock } = make({ restateEveryMinutes: 30, restateRevisions: 2 }, new ManualClock('2026-10-29T00:00:00.000Z'));
    const accounts = await connector.listAccounts();
    const utcish = accounts.find((a) => a.timezone === 'Europe/London')!;
    // The London day of 28 Oct (BST ended on the 25th, so GMT) ends at 2026-10-29T00:00Z.
    const window = dayWindow('2026-10-28T00:00:00.000Z', '2026-10-29T12:00:00.000Z');
    const rev = async () => (await pull(connector, utcish.accountId, window)).observations.map((o) => o.revision);
    expect(new Set(await rev())).toEqual(new Set([0]));
    clock.advance(30 * 60_000);
    expect(new Set(await rev())).toEqual(new Set([1]));
    clock.advance(30 * 60_000);
    expect(new Set(await rev())).toEqual(new Set([2]));
    clock.advance(5 * HOUR);
    expect(new Set(await rev())).toEqual(new Set([2]));
  });

  it('limits how far back it serves', async () => {
    const { connector } = make();
    const [account] = await connector.listAccounts();
    const { observations } = await pull(connector, account.accountId, hourWindow('2026-01-01T00:00:00.000Z', START));
    const earliest = Math.min(...observations.map((o) => Date.parse(o.periodStart)));
    expect(earliest).toBeGreaterThanOrEqual(Date.parse(START) - connector.capabilities().maxLookbackDays * 24 * HOUR);
  });

  describe('fault injection', () => {
    it('throws the injected errors, once per injection, then recovers', async () => {
      const { connector } = make();
      const [account] = await connector.listAccounts();
      const window = hourWindow('2026-10-28T10:00:00.000Z', START);
      connector.injectFault({ kind: 'rate_limit', retryAfterMs: 1500 });
      const err = await connector.fetchObservations(account, { window }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(RateLimitedError);
      expect((err as RateLimitedError).retryAfterMs).toBe(1500);
      connector.injectFault({ kind: 'transient' }, 2);
      await expect(connector.fetchObservations(account, { window })).rejects.toBeInstanceOf(TransientConnectorError);
      await expect(connector.listAccounts()).rejects.toBeInstanceOf(TransientConnectorError);
      connector.injectFault({ kind: 'auth' });
      await expect(connector.fetchObservations(account, { window })).rejects.toBeInstanceOf(ConnectorAuthError);
      connector.injectFault({ kind: 'request' });
      await expect(connector.listCampaigns(account)).rejects.toBeInstanceOf(ConnectorRequestError);
      expect((await connector.fetchObservations(account, { window })).observations.length).toBeGreaterThan(0);
    });

    it('fails at a configured, repeatable rate', async () => {
      const outcomes = async () => {
        const { connector } = make({ failureRate: 0.3, seed: 'rate' });
        const [account] = await connector.listAccounts().catch(() => [{ accountId: 'stub_meta_acct_1' }]);
        const window = hourWindow('2026-10-28T10:00:00.000Z', START);
        const results: string[] = [];
        for (let i = 0; i < 200; i += 1) {
          results.push(await connector.fetchObservations(account, { window }).then(() => 'ok', (e: Error) => e.name));
        }
        return results;
      };
      const a = await outcomes();
      expect(a).toEqual(await outcomes());
      const failures = a.filter((r) => r !== 'ok');
      expect(failures.length).toBeGreaterThan(30);
      expect(failures.length).toBeLessThan(90);
      expect(new Set(failures)).toEqual(new Set(['TransientConnectorError', 'RateLimitedError']));
    });

    it('can corrupt observations on demand', async () => {
      const { connector } = make();
      const [account] = await connector.listAccounts();
      const window = hourWindow('2026-10-28T10:00:00.000Z', START);
      for (const how of ['negative_spend', 'bad_period', 'missing_currency'] as const) {
        connector.corruptNext(how, 2);
        const { observations } = await connector.fetchObservations(account, { window });
        expect(observations.filter((o) => !metricObservationSchema.safeParse(o).success)).toHaveLength(2);
      }
      connector.corruptNext('wrong_platform', 1);
      const { observations } = await connector.fetchObservations(account, { window });
      expect(observations.filter((o) => o.platform !== 'meta')).toHaveLength(1);
      expect((await connector.fetchObservations(account, { window })).observations.every((o) => o.platform === 'meta')).toBe(true);
    });
  });

  it('rejects unknown accounts, bad cursors and bad page tokens', async () => {
    const { connector } = make();
    const window = hourWindow('2026-10-28T10:00:00.000Z', START);
    await expect(connector.fetchObservations({ accountId: 'nope' }, { window })).rejects.toBeInstanceOf(ConnectorRequestError);
    const [account] = await connector.listAccounts();
    await expect(connector.fetchObservations(account, { window, cursor: 'garbage' })).rejects.toBeInstanceOf(ConnectorRequestError);
    await expect(connector.fetchObservations(account, { window, pageToken: 'garbage' })).rejects.toBeInstanceOf(ConnectorRequestError);
  });

  describe('production guard', () => {
    it('refuses to be constructed in production without ALLOW_STUB_CONNECTOR', () => {
      const clock = new ManualClock();
      expect(() => new StubPlatformConnector({ platform: 'meta', clock, nodeEnv: 'production' })).toThrow(StubConnectorNotAllowedError);
      expect(() => new StubPlatformConnector({ platform: 'meta', clock, nodeEnv: 'production', allowStub: false })).toThrow(/development data source/);
    });

    it('starts in production only with the explicit opt-in, and anywhere else without it', () => {
      const clock = new ManualClock();
      expect(() => new StubPlatformConnector({ platform: 'meta', clock, nodeEnv: 'production', allowStub: true })).not.toThrow();
      for (const env of ['development', 'test', undefined]) {
        expect(() => new StubPlatformConnector({ platform: 'meta', clock, nodeEnv: env, allowStub: false })).not.toThrow();
      }
      expect(() => assertStubConnectorAllowed('production', false)).toThrow(StubConnectorNotAllowedError);
      expect(() => assertStubConnectorAllowed('production', true)).not.toThrow();
    });

    it('reads NODE_ENV and ALLOW_STUB_CONNECTOR from the environment by default', () => {
      const clock = new ManualClock();
      vi.stubEnv('NODE_ENV', 'production');
      vi.stubEnv('ALLOW_STUB_CONNECTOR', '');
      expect(() => new StubPlatformConnector({ platform: 'meta', clock })).toThrow(StubConnectorNotAllowedError);
      vi.stubEnv('ALLOW_STUB_CONNECTOR', 'true');
      expect(() => new StubPlatformConnector({ platform: 'meta', clock })).not.toThrow();
    });
  });
});
