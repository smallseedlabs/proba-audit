import { describe, expect, it } from 'vitest';
import { isValidTimeZone, metricObservationSchema, metricPlatformSchema } from '@smallseedlabs/proba-protocol/audit';
import type { ConnectorAccount, FetchWindow, MetricObservation } from '../domain/metrics.js';
import type { FetchPage, PlatformConnector } from '../ports/platform-connector.js';

export interface PlatformConnectorFixture {
  workspaceId?: string;
  /** The connector's notion of "now". For the stub this is its clock. */
  now: () => Date;
  /**
   * Move the connector's clock forward (the stub's ManualClock). Optional: when
   * given, the incremental-pull checks run. A connector against a live platform
   * cannot do this and skips them.
   */
  advance?: (ms: number) => void;
}

const HOUR = 3_600_000;
const keyOf = (o: MetricObservation): string =>
  [o.campaignId, o.adsetId ?? '', o.adId ?? '', o.granularity, o.periodStart].join('|');

/** Pull every page of one request. */
async function pullAll(
  connector: PlatformConnector,
  account: ConnectorAccount,
  window: FetchWindow,
  cursor?: string,
  pageSize?: number
): Promise<{ observations: MetricObservation[]; pages: FetchPage[]; cursor: string }> {
  const pages: FetchPage[] = [];
  let pageToken: string | undefined;
  do {
    const page = await connector.fetchObservations(account, { window, cursor, pageToken, pageSize });
    pages.push(page);
    pageToken = page.nextPageToken;
    if (pages.length > 10_000) throw new Error('connector never ends its pages');
  } while (pageToken);
  return { observations: pages.flatMap((p) => p.observations), pages, cursor: pages[pages.length - 1].nextCursor };
}

/**
 * Contract any PlatformConnector must satisfy. `factory` creates a fresh
 * connector for each test. Run it against every adapter (the stub, and any real
 * analytics library adapter with recorded data or a sandbox account).
 */
export function runPlatformConnectorContract(
  name: string,
  factory: () => PlatformConnector | Promise<PlatformConnector>,
  fixture: PlatformConnectorFixture
): void {
  describe(`PlatformConnector contract: ${name}`, () => {
    const workspaceId = fixture.workspaceId ?? 'seedbed';

    async function setup() {
      const connector = await factory();
      const caps = connector.capabilities();
      const accounts = await connector.listAccounts(workspaceId);
      const granularity = caps.granularities.includes('hour') ? 'hour' : caps.granularities[0];
      const to = new Date(Math.floor(fixture.now().getTime() / HOUR) * HOUR);
      const window: FetchWindow = { from: new Date(to.getTime() - 24 * HOUR).toISOString(), to: to.toISOString(), granularity };
      return { connector, caps, accounts, account: accounts[0], window };
    }

    it('reports capabilities with a stable platform id from the protocol enum', async () => {
      const { connector, caps } = await setup();
      expect(metricPlatformSchema.safeParse(connector.platform).success).toBe(true);
      expect(caps.platform).toBe(connector.platform);
      expect(connector.adapter).toMatch(/^[a-z][a-z0-9-]*$/);
      expect(caps.granularities.length).toBeGreaterThan(0);
      expect(caps.maxLookbackDays).toBeGreaterThan(0);
      expect(caps.restatementWindowHours).toBeGreaterThanOrEqual(0);
      expect(caps.maxPageSize).toBeGreaterThan(0);
      expect(typeof caps.supportsRestatements).toBe('boolean');
      expect(typeof caps.supportsCursor).toBe('boolean');
    });

    it('lists accounts and campaigns', async () => {
      const { connector, accounts } = await setup();
      expect(accounts.length).toBeGreaterThan(0);
      expect(new Set(accounts.map((a) => a.accountId)).size).toBe(accounts.length);
      for (const a of accounts) {
        expect(a.accountId.length).toBeGreaterThan(0);
        if (a.timezone !== undefined) expect(isValidTimeZone(a.timezone)).toBe(true);
        if (a.currency !== undefined) expect(a.currency).toHaveLength(3);
        expect(JSON.stringify(a)).not.toMatch(/secret|password|token/i);
      }
      const campaigns = await connector.listCampaigns(accounts[0]);
      expect(campaigns.length).toBeGreaterThan(0);
      expect(new Set(campaigns.map((c) => c.campaignId)).size).toBe(campaigns.length);
      for (const c of campaigns) expect(c.accountId).toBe(accounts[0].accountId);
    });

    it('returns valid observations of this platform and account, inside the window', async () => {
      const { connector, account, window } = await setup();
      const { observations } = await pullAll(connector, account, window);
      expect(observations.length).toBeGreaterThan(0);
      for (const o of observations) {
        expect(metricObservationSchema.safeParse(o).success).toBe(true);
        expect(o.platform).toBe(connector.platform);
        expect(o.accountId).toBe(account.accountId);
        expect(o.granularity).toBe(window.granularity);
        expect(Date.parse(o.periodStart)).toBeGreaterThanOrEqual(Date.parse(window.from));
        expect(Date.parse(o.periodEnd)).toBeLessThanOrEqual(Date.parse(window.to));
        expect(Number.isInteger(o.revision)).toBe(true);
        if (account.timezone !== undefined) expect(o.timezone).toBe(account.timezone);
      }
    });

    it('reports each key once per pull and one level per campaign', async () => {
      const { connector, account, window } = await setup();
      const { observations } = await pullAll(connector, account, window);
      expect(new Set(observations.map(keyOf)).size).toBe(observations.length);
      const levels = new Map<string, Set<string>>();
      for (const o of observations) {
        const level = o.adId !== undefined ? 'ad' : o.adsetId !== undefined ? 'adset' : 'campaign';
        levels.set(o.campaignId, (levels.get(o.campaignId) ?? new Set()).add(level));
      }
      for (const set of levels.values()) expect(set.size).toBe(1);
    });

    it('pages: small pages cover exactly the same observations as one big pull, with one cursor', async () => {
      const { connector, caps, account, window } = await setup();
      const whole = await pullAll(connector, account, window, undefined, caps.maxPageSize);
      const small = await pullAll(connector, account, window, undefined, 7);
      expect(small.pages.length).toBeGreaterThan(1);
      for (const p of small.pages.slice(0, -1)) expect(p.nextPageToken).toBeDefined();
      expect(small.pages[small.pages.length - 1].nextPageToken).toBeUndefined();
      for (const p of small.pages) expect(p.observations.length).toBeLessThanOrEqual(7);
      expect(small.observations.map(keyOf).sort()).toEqual(whole.observations.map(keyOf).sort());
      expect(new Set(small.pages.map((p) => p.nextCursor)).size).toBe(1);
      expect(small.cursor.length).toBeGreaterThan(0);
    });

    it('returns an empty list for a window with no data', async () => {
      const { connector, account, window } = await setup();
      const { observations } = await pullAll(connector, account, {
        ...window,
        from: '2000-01-01T00:00:00.000Z',
        to: '2000-01-02T00:00:00.000Z',
      });
      expect(observations).toEqual([]);
    });

    if (fixture.advance) {
      const advance = fixture.advance;
      it('pulls incrementally: with a cursor only new or restated observations come back', async () => {
        const { connector, caps, account, window } = await setup();
        if (!caps.supportsCursor) return;
        const first = await pullAll(connector, account, window);
        const seen = new Map(first.observations.map((o) => [keyOf(o), o]));

        const again = await pullAll(connector, account, window, first.cursor);
        expect(again.observations).toEqual([]);

        advance((caps.restatementWindowHours + 2) * HOUR);
        const later = new Date(Math.floor(fixture.now().getTime() / HOUR) * HOUR).toISOString();
        const wide: FetchWindow = { ...window, to: later };
        const next = await pullAll(connector, account, wide, first.cursor);
        expect(next.observations.length).toBeGreaterThan(0);
        for (const o of next.observations) {
          const prior = seen.get(keyOf(o));
          if (prior) expect(o.revision).toBeGreaterThan(prior.revision);
        }
        expect(next.observations.length).toBeLessThan((await pullAll(connector, account, wide)).observations.length);
      });
    }
  });
}
