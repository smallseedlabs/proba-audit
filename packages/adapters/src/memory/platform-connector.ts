import type {
  ConnectorAccount,
  FetchWindow,
  MetricObservation,
  MetricPlatform,
  PlatformConnector,
} from '@smallseedlabs/proba-audit-core';

/**
 * PlatformConnector that serves canned observations. For tests only; real
 * connectors (Meta, Google, ...) come later and implement the same port.
 */
export class StaticPlatformConnector implements PlatformConnector {
  constructor(
    readonly platform: MetricPlatform,
    private readonly data: MetricObservation[]
  ) {}

  async fetchMetrics(account: ConnectorAccount, window: FetchWindow): Promise<MetricObservation[]> {
    return this.data
      .filter(
        (o) =>
          o.platform === this.platform &&
          o.accountId === account.accountId &&
          o.granularity === window.granularity &&
          Date.parse(o.periodStart) >= Date.parse(window.from) &&
          Date.parse(o.periodEnd) <= Date.parse(window.to)
      )
      .map((o) => structuredClone(o));
  }
}
