import type { AppConfig } from '@smallseedlabs/proba-audit-core';

/** The registry name every in-memory adapter is registered under. */
export const IN_MEMORY_ADAPTER_NAME = 'memory';

export class InMemoryAdaptersNotAllowedError extends Error {
  constructor(readonly adapters: string[]) {
    super(
      `In-memory adapters lose their data on restart and are not shared between replicas, so they are disabled in production ` +
        `(selected: ${adapters.join(', ')}). Select a durable adapter, or set ALLOW_IN_MEMORY_ADAPTERS=true to run them deliberately.`
    );
    this.name = 'InMemoryAdaptersNotAllowedError';
  }
}

export interface InMemoryGuardOptions {
  /** The read API's rate limiter is created outside createRuntime; only audit-api checks it. */
  includeRateLimiter?: boolean;
  /** Only audit-consumer and audit-api use the anchor store; the other services do not need ANCHOR_STORE to be durable. */
  includeAnchorStore?: boolean;
}

/** The config keys (for example `AUDIT_STORE`) whose selected adapter is the in-memory one. */
export function selectedInMemoryAdapters(config: AppConfig, options: InMemoryGuardOptions = {}): string[] {
  const candidates: [string, string][] = [
    ['EVENT_BUS', config.adapters.eventBus],
    ['AUDIT_STORE', config.adapters.auditStore],
    ['METRICS_STORE', config.adapters.metricsStore],
    ['CHECKPOINT_STORE', config.adapters.checkpointStore],
    ['QUARANTINE_STORE', config.adapters.quarantineStore],
    ['AUDIT_CONTENT_STORE', config.adapters.auditContentStore],
  ];
  if (options.includeRateLimiter) candidates.push(['AUDIT_API_RATE_LIMITER', config.api.adapters.rateLimiter]);
  if (options.includeAnchorStore) candidates.push(['ANCHOR_STORE', config.adapters.anchorStore]);
  return candidates.filter(([, adapter]) => adapter === IN_MEMORY_ADAPTER_NAME).map(([key]) => key);
}

/** Throws unless in-memory adapters may run: anywhere but production, or production with the explicit opt-in. */
export function assertInMemoryAdaptersAllowed(config: AppConfig, options: InMemoryGuardOptions = {}): void {
  if (!config.isProduction || config.allowInMemoryAdapters) return;
  const selected = selectedInMemoryAdapters(config, options);
  if (selected.length > 0) throw new InMemoryAdaptersNotAllowedError(selected);
}
