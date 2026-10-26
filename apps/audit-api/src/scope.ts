import {
  AdapterRegistry,
  type AccessContext,
  type AnalyticsScope,
  type AppConfig,
  type Clock,
  type IdGenerator,
  type Logger,
  type MetricPlatform,
  type PlatformConnector,
  type ScopeResolver,
} from '@smallseedlabs/proba-audit-core';
import { createConnectors } from '@smallseedlabs/proba-audit-adapters';

/**
 * Which ad accounts a workspace may see in analytics. The metrics tables carry no workspace column
 * (they are keyed by ad account), so this is where a workspace is tied to its accounts. The scope is
 * produced here, from the authenticated session's workspace, and never from a request parameter.
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
    });
}
