/**
 * PlatformConnector port: fetches metrics from one ad platform and normalises
 * them into MetricObservations. Implementations come later (one per platform).
 */

import type {
  ConnectorAccount,
  FetchWindow,
  MetricObservation,
  MetricPlatform,
} from '../domain/metrics.js';

export interface PlatformConnector {
  readonly platform: MetricPlatform;
  /**
   * Observations for the account in the window. Every returned observation has
   * this connector's platform, the account's id and a period inside the window.
   */
  fetchMetrics(account: ConnectorAccount, window: FetchWindow): Promise<MetricObservation[]>;
}
