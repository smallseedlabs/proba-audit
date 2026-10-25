import { describe, expect, it } from 'vitest';
import type { ConnectorAccount, FetchWindow } from '../domain/metrics.js';
import type { PlatformConnector } from '../ports/platform-connector.js';
import { metricObservationSchema } from '@smallseedlabs/proba-protocol/audit';

export interface PlatformConnectorFixture {
  account: ConnectorAccount;
  window: FetchWindow;
}

/**
 * Contract any PlatformConnector must satisfy. The fixture should be an
 * account and window for which the connector has data (a recorded response or a
 * sandbox account).
 */
export function runPlatformConnectorContract(
  name: string,
  factory: () => PlatformConnector,
  fixture: PlatformConnectorFixture
): void {
  describe(`PlatformConnector contract: ${name}`, () => {
    it('returns valid observations for this platform and account inside the window', async () => {
      const connector = factory();
      const observations = await connector.fetchMetrics(fixture.account, fixture.window);
      expect(observations.length).toBeGreaterThan(0);
      for (const o of observations) {
        expect(metricObservationSchema.safeParse(o).success).toBe(true);
        expect(o.platform).toBe(connector.platform);
        expect(o.accountId).toBe(fixture.account.accountId);
        expect(o.granularity).toBe(fixture.window.granularity);
        expect(Date.parse(o.periodStart)).toBeGreaterThanOrEqual(Date.parse(fixture.window.from));
        expect(Date.parse(o.periodEnd)).toBeLessThanOrEqual(Date.parse(fixture.window.to));
      }
    });

    it('returns an empty list for a window with no data', async () => {
      const connector = factory();
      const observations = await connector.fetchMetrics(fixture.account, {
        ...fixture.window,
        from: '2000-01-01T00:00:00.000Z',
        to: '2000-01-02T00:00:00.000Z',
      });
      expect(observations).toEqual([]);
    });
  });
}
