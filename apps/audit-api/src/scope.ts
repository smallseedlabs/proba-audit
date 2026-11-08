import {
  AdapterRegistry,
  type AccessContext,
  type AnalyticsScope,
  type AppConfig,
  type Clock,
  type IdGenerator,
  type Logger,
  type MetricPlatform,
  type MetricsStore,
  type PlatformConnector,
  type ScopeResolver,
} from '@smallseedlabs/proba-audit-core';
import { createConnectors } from '@smallseedlabs/proba-audit-adapters';

/**
 * Which ad accounts a workspace may see in analytics. Metric tables are keyed by workspace_id
 * (migration 0009) and then ad account. The scope is produced here, from the authenticated
 * session's workspace, and never from a request parameter. `metrics` lists accounts already
 * stored; it does not call an ad platform.
 */
export interface ScopeSource {
  resolve: ScopeResolver;
  close(): Promise<void>;
}

export interface ScopeDeps {
  config: AppConfig;
  logger: Logger;
  clock: Clock;
  ids: IdGenerator;
  /** Required when AUDIT_API_SCOPE_SOURCE=metrics (Ads-driven, no provider listAccounts). */
  metricsStore?: MetricsStore;
}

/** AUDIT_API_ANALYTICS_ACCOUNTS: a fixed list of accounts for the configured workspace. */
export function createStaticScope(workspaceId: string, accounts: readonly { platform: MetricPlatform; accountId: string }[]): ScopeSource {
  return {
    async resolve(ctx: AccessContext): Promise<AnalyticsScope> {
      return { workspaceId: ctx.workspaceId, accounts: ctx.workspaceId === workspaceId ? accounts : [] };
    },
    async close() {
      // Nothing to release.
    },
  };
}

/**
 * Accounts already stored in MetricsStore for the workspace. Used when Ads emits
 * observations onto the audit stream and there is no PlatformConnector to list.
 * Never opens a provider HTTP client.
 */
export function createMetricsStoreScope(metricsStore: MetricsStore, cacheMs: number, clock: Clock): ScopeSource {
  let cached: { at: number; workspaceId: string; scope: AnalyticsScope } | undefined;
  return {
    async resolve(ctx: AccessContext): Promise<AnalyticsScope> {
      const now = clock.now().getTime();
      if (cached && cached.workspaceId === ctx.workspaceId && now - cached.at < cacheMs) return cached.scope;
      const accounts = await metricsStore.listAccounts(ctx.workspaceId);
      cached = { at: now, workspaceId: ctx.workspaceId, scope: { workspaceId: ctx.workspaceId, accounts } };
      return cached.scope;
    },
    async close() {
      // The MetricsStore is owned by the runtime.
    },
  };
}

/**
 * The accounts the platform connectors report for the workspace (the same source the ingester and
 * `metrics-report` use), cached for `cacheMs` so a burst of requests asks the platforms once.
 */
export function createConnectorScope(
  workspaceId: string,
  connectors: ReadonlyMap<MetricPlatform, PlatformConnector>,
  options: { cacheMs: number; clock: Clock; logger: Logger }
): ScopeSource {
  let cached: { at: number; scope: AnalyticsScope } | undefined;
  return {
    async resolve(ctx: AccessContext): Promise<AnalyticsScope> {
      if (ctx.workspaceId !== workspaceId) return { workspaceId: ctx.workspaceId, accounts: [] };
      const now = options.clock.now().getTime();
      if (cached && now - cached.at < options.cacheMs) return cached.scope;
      const accounts: AnalyticsScope['accounts'][number][] = [];
      for (const [platform, connector] of connectors) {
        try {
          for (const a of await connector.listAccounts(workspaceId)) accounts.push({ platform, accountId: a.accountId });
        } catch (err) {
          // One platform being down must not blank the others; its accounts are simply absent until it answers.
          options.logger.error('listing ad accounts failed', { platform, err });
          if (cached) return cached.scope;
        }
      }
      cached = { at: now, scope: { workspaceId, accounts } };
      return cached.scope;
    },
    async close() {
      await Promise.allSettled([...connectors.values()].map((c) => c.close?.()));
    },
  };
}

export function createScopeRegistry(): AdapterRegistry<ScopeSource, ScopeDeps> {
  return new AdapterRegistry<ScopeSource, ScopeDeps>('ScopeResolver')
    .register('static', ({ config }) => createStaticScope(config.api.workspaceId, config.api.analyticsAccounts))
    .register('connectors', async ({ config, logger, clock, ids }) => {
      const connectors = await createConnectors(config, { logger, clock, ids });
      return createConnectorScope(config.api.workspaceId, connectors, { cacheMs: config.api.scopeCacheMs, clock, logger });
    })
    .register('metrics', ({ metricsStore, clock, config }) => {
      if (!metricsStore) throw new Error('AUDIT_API_SCOPE_SOURCE=metrics requires a MetricsStore');
      return createMetricsStoreScope(metricsStore, config.api.scopeCacheMs, clock);
    });
}
