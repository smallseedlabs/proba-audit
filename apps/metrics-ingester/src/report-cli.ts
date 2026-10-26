/**
 * `metrics-report`: prints what the metrics flow has stored for the workspace, read through
 * the same analytics functions the portal will use (MetricsAnalytics), plus the audit trail
 * of the sync and rollup runs. Used by the end-to-end compose profile and by operators.
 *
 *   node apps/metrics-ingester/dist/report-cli.js [--wait-seconds=N]
 *
 * With --wait-seconds it polls until the rollups have data (or the time is up), so it can be
 * started together with the ingester and the rollup worker.
 */
import { MetricsAnalytics, createLogger, loadConfigFromEnvironment, type AnalyticsScope } from '@smallseedlabs/proba-audit-core';
import { createConnectors, createRuntime } from '@smallseedlabs/proba-audit-adapters';

const DAY_MS = 86_400_000;

async function main(): Promise<void> {
  const waitArg = process.argv.find((a) => a.startsWith('--wait-seconds='));
  const waitSeconds = waitArg ? Number(waitArg.split('=')[1]) : 0;
  const config = loadConfigFromEnvironment({ serviceName: 'metrics-report', defaultPort: 0 });
  const logger = createLogger({ service: config.service.name, level: 'warn', env: config.env });
  const runtime = await createRuntime(config, { logger, clickhouseRole: 'api' });
  const connectors = await createConnectors(config, { logger, clock: runtime.clock, ids: runtime.ids });

  try {
    // The scope: the ad accounts the connectors report for this workspace.
    const accounts: AnalyticsScope['accounts'][number][] = [];
    for (const [platform, connector] of connectors) {
      for (const a of await connector.listAccounts(config.ingest.workspaceId)) accounts.push({ platform, accountId: a.accountId });
    }
    const scope: AnalyticsScope = { workspaceId: config.ingest.workspaceId, accounts };
    const analytics = new MetricsAnalytics(runtime.metricsStore, { sourceGranularity: config.ingest.granularity });

    const now = runtime.clock.now().getTime();
    const todayStart = Math.floor(now / DAY_MS) * DAY_MS;
    const range = { from: new Date(todayStart - 2 * DAY_MS).toISOString(), to: new Date(todayStart + DAY_MS).toISOString() };

    const deadline = Date.now() + waitSeconds * 1000;
    let summary = await analytics.getMetricsSummary(scope, { granularity: 'day', ...range });
    while (summary.totals.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 2000));
      summary = await analytics.getMetricsSummary(scope, { granularity: 'day', ...range });
    }
    // Give the ingester a moment to restate and the rollup worker to follow, so the audit trail shows a restatement.
    if (waitSeconds > 0) {
      while (Date.now() < deadline) {
        const events = await runtime.auditStore.aggregate({ filter: { workspaceId: config.ingest.workspaceId }, groupBy: ['action'] });
        if (events.some((e) => e.keys.action === 'metrics.rollup_run') && events.some((e) => e.keys.action === 'metrics.restated')) break;
        await new Promise((r) => setTimeout(r, 2000));
      }
      // Let the rollup worker (and the audit consumer) catch up with the last restatement before reading.
      await new Promise((r) => setTimeout(r, config.rollup.intervalMs * 2 + 3000));
      summary = await analytics.getMetricsSummary(scope, { granularity: 'day', ...range });
    }

    const comparison = await analytics.comparePeriods(scope, {
      granularity: 'day',
      current: { from: new Date(todayStart - DAY_MS).toISOString(), to: new Date(todayStart).toISOString() },
    });
    const hourly = await analytics.getMetricsSummary(scope, {
      granularity: 'hour',
      from: new Date(Math.floor(now / 3_600_000) * 3_600_000 - 6 * 3_600_000).toISOString(),
      to: new Date(Math.floor(now / 3_600_000) * 3_600_000).toISOString(),
    });
    const audit = await runtime.auditStore.aggregate({ filter: { workspaceId: config.ingest.workspaceId }, groupBy: ['action', 'outcome'] });
    const quarantined = await runtime.quarantineStore.list({ workspaceId: config.ingest.workspaceId, limit: 1000 });

    const out = {
      workspaceId: scope.workspaceId,
      accounts: accounts.length,
      connectors: [...connectors.entries()].map(([p, c]) => `${p}:${c.adapter}`),
      dailySummary: { from: summary.from, to: summary.to, totals: summary.totals, series: summary.series.slice(0, 12), topCampaigns: summary.campaigns?.slice(0, 5) },
      yesterdayVsDayBefore: comparison.comparison,
      lastSixHours: hourly.series.map((p) => ({ hour: p.bucket, currency: p.currency, impressions: p.impressions, clicks: p.clicks, spend: p.spend, conversions: p.conversions })),
      auditEvents: audit
        .map((r) => ({ action: r.keys.action, outcome: r.keys.outcome, count: r.count }))
        .filter((r) => String(r.action).startsWith('metrics.'))
        .sort((a, b) => String(a.action).localeCompare(String(b.action))),
      quarantined: quarantined.length,
    };
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(out, null, 2));
    if (summary.totals.length === 0) process.exitCode = 1;
  } finally {
    await Promise.allSettled([...connectors.values()].map((c) => c.close?.()));
    await runtime.close();
  }
}

main().catch((err) => {
  console.error('fatal: metrics-report failed', err);
  process.exit(1);
});
