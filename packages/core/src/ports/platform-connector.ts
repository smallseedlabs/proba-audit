/**
 * PlatformConnector port: how the metrics ingester talks to one ad platform.
 *
 * Each ad platform (Meta, Google, Reddit, X, Microsoft) is reached through its
 * own analytics library. An adapter wraps that library behind this port and
 * returns protocol MetricObservations, so the ingester never knows which library
 * (or the development data source) is behind it. Adapters are chosen by config:
 * PLATFORM_CONNECTORS=meta:<adapter-name>,google:<adapter-name>.
 *
 * Rules every adapter follows (runPlatformConnectorContract checks them):
 * - Observations are valid MetricObservations of this connector's `platform`,
 *   the requested account and granularity, with a period inside the window.
 * - `revision` starts at 0 for the first report of a period and grows by one each
 *   time the platform restates it (late conversions, spend corrections).
 * - Report ONE level per campaign, the finest the platform has (ad rows, or
 *   adset rows, or campaign rows). Rollups sum rows per campaign, so mixing levels
 *   inside one campaign would double count.
 * - Never put credentials in an observation (`sourceRef` is an opaque pointer).
 * - Failures are thrown as the typed errors below so the ingester can decide
 *   between retrying, waiting for a rate limit and giving up.
 */

import type {
  ConnectorAccount,
  ConnectorCampaign,
  FetchWindow,
  MetricGranularity,
  MetricObservation,
  MetricPlatform,
} from '../domain/metrics.js';

export interface ConnectorCapabilities {
  /** Stable platform id from the protocol's platform enum. */
  platform: MetricPlatform;
  granularities: readonly MetricGranularity[];
  /** How far back the platform can be asked for data. */
  maxLookbackDays: number;
  /** True when the platform restates past periods (the connector then reports revisions). */
  supportsRestatements: boolean;
  /** How far back from now a period may still be restated. The ingester re-pulls at least this window. */
  restatementWindowHours: number;
  /** True when fetchObservations honours `cursor` and returns only what changed since it. */
  supportsCursor: boolean;
  /** Largest page the connector returns. */
  maxPageSize: number;
}

export interface FetchRequest {
  /** Periods to report: periodStart >= window.from and periodEnd <= window.to. */
  window: FetchWindow;
  /**
   * Opaque token from the previous successful pull (`FetchPage.nextCursor`). When
   * set and the connector supports cursors, only new or restated observations are
   * returned. Omit for a full pull of the window.
   */
  cursor?: string;
  /** Opaque token from `FetchPage.nextPageToken` to continue the same pull. */
  pageToken?: string;
  pageSize?: number;
}

export interface FetchPage {
  observations: MetricObservation[];
  /** Present while more pages of this pull remain. */
  nextPageToken?: string;
  /**
   * Cursor to store once the WHOLE pull (all pages) has been ingested. It is the
   * same on every page of one pull.
   */
  nextCursor: string;
}

export interface PlatformConnector {
  /** Stable platform id (protocol enum). */
  readonly platform: MetricPlatform;
  /** Name of the adapter that produced this connector, as used in PLATFORM_CONNECTORS (for example `stub`). */
  readonly adapter: string;
  capabilities(): ConnectorCapabilities;
  /** Ad accounts the workspace has connected on this platform. */
  listAccounts(workspaceId: string): Promise<ConnectorAccount[]>;
  listCampaigns(account: ConnectorAccount): Promise<ConnectorCampaign[]>;
  /** One page of observations for the account. Throws ConnectorError subclasses. */
  fetchObservations(account: ConnectorAccount, request: FetchRequest): Promise<FetchPage>;
  close?(): Promise<void>;
}

export type ConnectorErrorCode = 'rate_limited' | 'transient' | 'auth' | 'invalid_request';

/** Base class of everything a connector throws on purpose. */
export class ConnectorError extends Error {
  constructor(
    message: string,
    readonly code: ConnectorErrorCode,
    /** True when trying again later may succeed. */
    readonly retryable: boolean
  ) {
    super(message);
    this.name = 'ConnectorError';
  }
}

/** The platform asked us to slow down. `retryAfterMs` is its hint, when it gave one. */
export class RateLimitedError extends ConnectorError {
  constructor(
    message = 'rate limited by the platform',
    readonly retryAfterMs?: number
  ) {
    super(message, 'rate_limited', true);
    this.name = 'RateLimitedError';
  }
}

/** Network error, timeout or 5xx: worth retrying with backoff. */
export class TransientConnectorError extends ConnectorError {
  constructor(message = 'temporary platform error') {
    super(message, 'transient', true);
    this.name = 'TransientConnectorError';
  }
}

/** Credentials missing, expired or revoked. Retrying cannot help. */
export class ConnectorAuthError extends ConnectorError {
  constructor(message = 'platform credentials rejected') {
    super(message, 'auth', false);
    this.name = 'ConnectorAuthError';
  }
}

/** The request itself is wrong (window too old, unsupported granularity, unknown account). */
export class ConnectorRequestError extends ConnectorError {
  constructor(message = 'request rejected by the platform adapter') {
    super(message, 'invalid_request', false);
    this.name = 'ConnectorRequestError';
  }
}
