import {
  createBusAuditEmitter,
  runService,
  type AuditEmitter,
} from '@smallseedlabs/proba-audit-core';
import { createRuntime, type Runtime } from '@smallseedlabs/proba-audit-adapters';
import { AuditConsumer } from './consumer.js';

let runtime: Runtime | undefined;
let consumer: AuditConsumer | undefined;

/**
 * audit-consumer: reads the audit topic with a consumer group, validates, dedupes,
 * chains per workspace and writes to the AuditStore. Run ONE replica (see
 * docs/ARCHITECTURE.md, "Single writer").
 */
runService({
  name: 'audit-consumer',
  defaultPort: 3101,
  async onStart({ config, logger }) {
    runtime = await createRuntime(config, { logger });
    await runtime.auditStore.ping();
    await runtime.eventBus.ping();

    // The consumer audits itself through the same emitter and bus as every service.
    // 'swallow': an audit hiccup must never stop audit ingestion.
    const emitter: AuditEmitter | undefined = config.consumer.selfAudit
      ? createBusAuditEmitter({
          bus: runtime.eventBus,
          topic: config.eventBus.auditTopic,
          service: config.service.name,
          defaultWorkspaceId: config.consumer.selfAuditWorkspaceId,
          clock: runtime.clock,
          ids: runtime.ids,
          logger,
          failureMode: 'swallow',
        })
      : undefined;

    consumer = new AuditConsumer({
      bus: runtime.eventBus,
      store: runtime.auditStore,
      clock: runtime.clock,
      ids: runtime.ids,
      logger,
      emitter,
      options: {
        topic: config.eventBus.auditTopic,
        group: config.eventBus.consumerGroup,
        consumerName: config.eventBus.consumerName,
        batchSize: config.eventBus.batchSize,
        blockMs: config.eventBus.blockMs,
        claimIdleMs: config.eventBus.claimIdleMs,
        maxDeliveries: config.eventBus.maxDeliveries,
        reclaimIntervalMs: config.consumer.reclaimIntervalMs,
        retryBaseMs: config.consumer.retryBaseMs,
        retryMaxMs: config.consumer.retryMaxMs,
        serviceName: config.service.name,
        selfAuditWorkspaceId: config.consumer.selfAuditWorkspaceId,
      },
    });
    await consumer.start();
  },
  async onStop() {
    await consumer?.stop();
    await runtime?.close();
  },
}).catch((err) => {
  console.error('fatal: audit-consumer failed to start', err);
  process.exit(1);
});
