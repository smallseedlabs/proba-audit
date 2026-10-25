import { createBusAuditEmitter, runService } from '@smallseedlabs/proba-audit-core';
import { createRuntime, type Runtime } from '@smallseedlabs/proba-audit-adapters';
import { RollupWorker } from './rollup-worker.js';

let runtime: Runtime | undefined;
let worker: RollupWorker | undefined;

/**
 * rollup: recomputes the hourly and daily rollups for whatever changed in the
 * observations (new periods and restatements). Run ONE replica.
 */
runService({
  name: 'rollup',
  defaultPort: 3103,
  async onStart({ config, logger }) {
    runtime = await createRuntime(config, { logger });
    await Promise.all([runtime.metricsStore.ping(), runtime.checkpointStore.ping(), runtime.eventBus.ping()]);
    const emitter = createBusAuditEmitter({
      bus: runtime.eventBus,
      topic: config.eventBus.auditTopic,
      service: config.service.name,
      defaultWorkspaceId: config.ingest.workspaceId,
      clock: runtime.clock,
      ids: runtime.ids,
      logger,
      failureMode: 'swallow',
    });
    worker = new RollupWorker({
      metricsStore: runtime.metricsStore,
      checkpoints: runtime.checkpointStore,
      emitter,
      clock: runtime.clock,
      ids: runtime.ids,
      logger,
      options: {
        workspaceId: config.ingest.workspaceId,
        serviceName: config.service.name,
        intervalMs: config.rollup.intervalMs,
        maxWindowDays: config.rollup.maxWindowDays,
      },
    });
    worker.start();
  },
  async onStop() {
    await worker?.stop();
    await runtime?.close();
  },
}).catch((err) => {
  console.error('fatal: rollup failed to start', err);
  process.exit(1);
});
