import {
  createBusAuditEmitter,
  createLogger,
  isPolicyEmptyForConfig,
  loadConfigFromEnvironment,
  redactConfig,
  type AuditEmitter,
} from '@smallseedlabs/proba-audit-core';
import { createDefaultRegistries, createRuntime } from '@smallseedlabs/proba-audit-adapters';
import { buildServer } from './server.js';
import { createScopeRegistry } from './scope.js';

/**
 * audit-api: the read-only HTTP API over the audit trail and the ad-metrics analytics.
 * Lifecycle mirrors the other apps (config, adapters, listen, signals) and proba-hub (Fastify).
 */
async function main(): Promise<void> {
  const config = loadConfigFromEnvironment({ serviceName: 'audit-api', defaultPort: 3100 });
  const logger = createLogger({
    service: config.service.name,
    level: config.log.level,
    env: config.env,
    pretty: config.isDevelopment && Boolean(process.stdout.isTTY),
  });
  logger.info('service starting', { lifecycle: 'starting', nodeVersion: process.version });
  logger.info('config loaded', { lifecycle: 'config_loaded', config: redactConfig(config) });

  if (isPolicyEmptyForConfig(config)) {
    logger.warn('no AUDIT_API_ALLOWED_EMAILS, AUDIT_API_ALLOWED_EMAIL_DOMAINS or AUDIT_API_ADMIN_EMAILS set: nobody can use the API', {
      lifecycle: 'no_access_configured',
    });
  }

  const runtime = await createRuntime(config, { logger });
  const registries = createDefaultRegistries();
  const deps = { config, logger, clock: runtime.clock, ids: runtime.ids };
  const verifier = await registries.tokenVerifier.create(config.api.adapters.tokenVerifier, deps);
  const limiter = await registries.rateLimiter.create(config.api.adapters.rateLimiter, deps);
  const scope = await createScopeRegistry().create(config.api.adapters.scopeSource, deps);
  logger.info('api adapters created', {
    lifecycle: 'adapters_created',
    tokenVerifier: verifier.name,
    rateLimiter: config.api.adapters.rateLimiter,
    scopeSource: config.api.adapters.scopeSource,
  });

  const emitterFor = (failureMode: 'throw' | 'swallow'): AuditEmitter =>
    createBusAuditEmitter({
      bus: runtime.eventBus,
      topic: config.eventBus.auditTopic,
      service: config.service.name,
      defaultWorkspaceId: config.api.workspaceId,
      clock: runtime.clock,
      ids: runtime.ids,
      logger,
      failureMode,
    });
  const bestEffortEmitter = emitterFor('swallow');

  await Promise.all([runtime.auditStore.ping(), runtime.metricsStore.ping(), runtime.eventBus.ping()]);

  const app = await buildServer({
    config,
    logger,
    clock: runtime.clock,
    verifier,
    limiter,
    auditStore: runtime.auditStore,
    metricsStore: runtime.metricsStore,
    scope: scope.resolve,
    emitter: emitterFor('throw'),
    bestEffortEmitter,
    readiness: [
      { name: 'auditStore', check: () => runtime.auditStore.ping() },
      { name: 'metricsStore', check: () => runtime.metricsStore.ping() },
      { name: 'eventBus', check: () => runtime.eventBus.ping() },
    ],
  });

  let stopping: Promise<void> | undefined;
  const stop = (reason: string): Promise<void> => {
    stopping ??= (async () => {
      logger.info('service stopping', { lifecycle: 'stopping', reason });
      await bestEffortEmitter.emit({
        actor: { type: 'service', id: config.service.name },
        action: 'system.stopped',
        category: 'system',
        outcome: 'success',
        details: { signal: reason },
      });
      await app.close();
      await Promise.allSettled([limiter.close(), scope.close(), runtime.close()]);
      logger.info('service stopped', { lifecycle: 'stopped' });
    })();
    return stopping;
  };
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => {
      stop(signal).then(
        () => process.exit(0),
        (err) => {
          logger.error('error while stopping', { lifecycle: 'stop_error', err });
          process.exit(1);
        }
      );
    });
  }

  await app.listen({ port: config.service.port, host: config.service.host });
  logger.info('http server listening', { lifecycle: 'listening', host: config.service.host, port: config.service.port });
  await bestEffortEmitter.emit({
    actor: { type: 'service', id: config.service.name },
    action: 'system.started',
    category: 'system',
    outcome: 'success',
    details: { tokenVerifier: verifier.name, rateLimiter: config.api.adapters.rateLimiter, scopeSource: config.api.adapters.scopeSource },
  });
  logger.info('service started', { lifecycle: 'started' });
}

main().catch((err) => {
  console.error('fatal: audit-api failed to start', err);
  process.exit(1);
});
