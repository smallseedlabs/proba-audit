import {
  ConnectorRequestError,
  type ConnectorAccount,
  type ConnectorCampaign,
  type ConnectorCapabilities,
  type FetchPage,
  type FetchRequest,
  type MetricObservation,
  type MetricPlatform,
  type PlatformConnector,
} from '@smallseedlabs/proba-audit-core';

/**
 * PlatformConnector that serves canned observations: a full pull every time, no
 * cursor. For unit tests of code that needs "some connector"; the development
 * data source is StubPlatformConnector.
 */
export class StaticPlatformConnector implements PlatformConnector {
  readonly adapter = 'static';

  constructor(
    readonly platform: MetricPlatform,
    private readonly data: MetricObservation[],
    private readonly accounts: ConnectorAccount[] = [...new Set(data.map((o) => o.accountId))].map((accountId) => ({ accountId }))
  ) {}

  capabilities(): ConnectorCapabilities {
    return {
      platform: this.platform,
      granularities: ['hour', 'day'],
      maxLookbackDays: 3650,
      supportsRestatements: true,
      restatementWindowHours: 0,
      supportsCursor: false,
      maxPageSize: 10_000,
    };
  }

  async listAccounts(): Promise<ConnectorAccount[]> {
    return this.accounts.map((a) => ({ ...a }));
  }

  async listCampaigns(account: ConnectorAccount): Promise<ConnectorCampaign[]> {
    const ids = new Set(this.data.filter((o) => o.accountId === account.accountId).map((o) => o.campaignId));
    return [...ids].map((campaignId) => ({ campaignId, accountId: account.accountId, name: campaignId, status: 'active' as const }));
  }

  async fetchObservations(account: ConnectorAccount, request: FetchRequest): Promise<FetchPage> {
    if (request.pageToken !== undefined && !/^\d+$/.test(request.pageToken)) throw new ConnectorRequestError('bad page token');
    const { window } = request;
    const all = this.data
      .filter(
        (o) =>
          o.platform === this.platform &&
          o.accountId === account.accountId &&
          o.granularity === window.granularity &&
          Date.parse(o.periodStart) >= Date.parse(window.from) &&
          Date.parse(o.periodEnd) <= Date.parse(window.to)
      )
      .sort((a, b) => a.periodStart.localeCompare(b.periodStart));
    const size = Math.min(request.pageSize ?? 10_000, 10_000);
    const offset = request.pageToken ? Number(request.pageToken) : 0;
    const slice = all.slice(offset, offset + size);
    return {
      observations: slice.map((o) => structuredClone(o)),
      ...(offset + size < all.length ? { nextPageToken: String(offset + size) } : {}),
      nextCursor: 'static',
    };
  }
}
