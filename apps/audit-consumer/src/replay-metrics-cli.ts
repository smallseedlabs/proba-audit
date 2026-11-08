/**
 * Rebuild metric observations from the durable audit log (ClickHouse audit_events).
 *
 *   node apps/audit-consumer/dist/replay-metrics-cli.js --workspace=seedbed [--from=ISO] [--to=ISO] [--compute-rollups]
 *
 * Reads AuditStore only, writes MetricsStore / quarantine. Never opens a provider
 * HTTP client, never publishes, never talks to Redis except if those adapters are
 * selected for unrelated runtime ports (this CLI uses the stores only).
 *
 * Not a live migration: it does not ALTER shared volumes. Apply 0010 with
 * `npm run migrate` against the target database first.
 */
import { createLogger, loadConfigFromEnvironment, replayMetricsFromAudit } from '@smallseedlabs/proba-audit-core';
import { createRuntime } from '@smallseedlabs/proba-audit-adapters';

function arg(name: string): string | undefined {
  const prefix = `--${name}=`;
  const found = process.argv.find((a) => a.startsWith(prefix));
  return found ? found.slice(prefix.length) : undefined;
}

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

async function main(): Promise<void> {
  const workspaceId = arg('workspace');
  if (!workspaceId) {
    throw new Error('usage: replay-metrics-cli --workspace=<id> [--from=ISO] [--to=ISO] [--compute-rollups]');
  }
  const config = loadConfigFromEnvironment({ serviceName: 'metrics-replay', defaultPort: 0 });
  const logger = createLogger({ service: config.service.name, level: config.log.level, env: config.env });
  const runtime = await createRuntime(config, { logger, clickhouseRole: 'consumer' });
  try {
    await Promise.all([runtime.auditStore.ping(), runtime.metricsStore.ping(), runtime.quarantineStore.ping()]);
    const result = await replayMetricsFromAudit(
      runtime.auditStore,
      {
        metricsStore: runtime.metricsStore,
        quarantine: runtime.quarantineStore,
        ids: runtime.ids,
        clock: runtime.clock,
      },
      {
        workspaceId,
        ...(arg('from') ? { from: arg('from') } : {}),
        ...(arg('to') ? { to: arg('to') } : {}),
        computeRollups: flag('compute-rollups'),
      }
    );
    logger.info('metrics replay finished', { workspaceId, ...result });
    process.stdout.write(`${JSON.stringify({ workspaceId, ...result })}\n`);
  } finally {
    await runtime.close();
  }
}

main().catch((err) => {
  console.error('fatal: metrics replay failed', err);
  process.exit(1);
});
