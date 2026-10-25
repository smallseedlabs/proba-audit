import { createBusAuditEmitter, runService } from '@smallseedlabs/proba-audit-core';
import { createConnectors, createRuntime, type Runtime } from '@smallseedlabs/proba-audit-adapters';
import type { MetricPlatform, PlatformConnector } from '@smallseedlabs/proba-audit-core';
import { IngestScheduler } from './scheduler.js';
import { SyncEngine } from './sync-engine.js';

let runtime: Runtime | undefined;
let scheduler: IngestScheduler | undefined;
let connectors: Map<MetricPlatform, PlatformConnector> | undefined;

/**
 * metrics-ingester: pulls ad-platform metrics through the PlatformConnector port,
 * validates them and stores them (with revisions) in the MetricsStore. Which
 * connector serves which platform is config only: PLATFORM_CONNECTORS=meta:stub,google:stub
 * today, meta:<analytics-lib> when the real library exists. Run ONE replica
 * (see docs/ARCHITECTURE.md, "Metrics flow").
 */
runService({
  name: 'metrics-ingester',
  defaultPort: 3102,
  async onStart({ config, logger }) {
    runtime = await createRuntime(config, { logger });
    await Promise.all([
      runtime.metricsStore.ping(),
      runtime.checkpointStore.ping(),
      runtime.quarantineStore.ping(),
      runtime.eventBus.ping(),
    ]);
    // Throws (and the process exits) for an unknown adapter name or the stub in production without ALLOW_STUB_CONNECTOR=true.
    connectors = await createConnectors(config, { logger, clock: runtime.clock, ids: runtime.ids });
    if (connectors.size === 0) {
      logger.warn('no platform connectors configured: set PLATFORM_CONNECTORS, for example meta:stub', {
        lifecycle: 'no_connectors',
      });
    }

    const emitter = createBusAuditEmitter({
      bus: runtime.eventBus,
      topic: config.eventBus.auditTopic,
      service: config.service.name,
      defaultWorkspaceId: config.ingest.workspaceId,
      clock: runtime.clock,
      ids: runtime.ids,
      logger,
      // A lost audit event must never stop ingestion.
      failureMode: 'swallow',
    });

    const engine = new SyncEngine({
      metricsStore: runtime.metricsStore,
      checkpoints: runtime.checkpointStore,
      quarantine: runtime.quarantineStore,
      emitter,
      clock: runtime.clock,
      ids: runtime.ids,
      logger,
      options: {
        workspaceId: config.ingest.workspaceId,
        serviceName: config.service.name,
        granularity: config.ingest.granularity,
        initialLookbackHours: config.ingest.initialLookbackHours,
        pageSize: config.ingest.pageSize,
        retry: {
          maxAttempts: config.ingest.maxAttempts,
          baseMs: config.ingest.retryBaseMs,
          maxMs: config.ingest.retryMaxMs,
          maxRateLimitWaitMs: config.ingest.maxRateLimitWaitMs,
        },
      },
    });
    scheduler = new IngestScheduler({
      connectors,
      engine,
      clock: runtime.clock,
      logger,
      options: {
        workspaceId: config.ingest.workspaceId,
        intervalMs: config.ingest.intervalMs,
        intervalOverridesMs: config.ingest.intervalOverridesMs,
        jitterRatio: config.ingest.jitterRatio,
        failureBackoffMaxMs: config.ingest.failureBackoffMaxMs,
        accountRefreshMs: config.ingest.accountRefreshMs,
      },
    });
    await scheduler.start();
  },
  async onStop() {
    await scheduler?.stop();
    await Promise.allSettled([...(connectors?.values() ?? [])].map((c) => c.close?.()));
    await runtime?.close();
  },
}).catch((err) => {
  console.error('fatal: metrics-ingester failed to start', err);
  process.exit(1);
});
