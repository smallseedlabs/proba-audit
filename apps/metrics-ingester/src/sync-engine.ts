import {
  validateMetricObservation,
  type AuditEmitter,
  type CheckpointStore,
  type Clock,
  type ConnectorAccount,
  type FetchWindow,
  type IdGenerator,
  type Logger,
  type MetricGranularity,
  type MetricObservation,
  type MetricsStore,
  type PlatformConnector,
  type QuarantinedObservation,
  type QuarantineStore,
} from '@smallseedlabs/proba-audit-core';
import { SyncStepError, redactSecrets, withRetry, type RetryPolicy } from './retry.js';

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const MAX_PAGES = 10_000;
const MAX_PAYLOAD_CHARS = 64_000;

export interface SyncEngineOptions {
  workspaceId: string;
  /** Name stamped on audit events (the actor id and the service). */
  serviceName: string;
  granularity: MetricGranularity;
  initialLookbackHours: number;
  pageSize: number;
  retry: RetryPolicy;
}

export interface SyncEngineDeps {
  metricsStore: MetricsStore;
  checkpoints: CheckpointStore;
  quarantine: QuarantineStore;
  /** Optional: without it the engine only logs. */
  emitter?: AuditEmitter;
  clock: Clock;
  ids: IdGenerator;
  logger: Logger;
  options: SyncEngineOptions;
  /** Injected in tests to avoid real waiting. */
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

export interface SyncOutcome {
  /** Doubles as the traceId of every log line and audit event of the run. */
  runId: string;
  platform: string;
  accountId: string;
  status: 'completed' | 'failed';
  window: FetchWindow;
  durationMs: number;
  pages: number;
  received: number;
  /** Periods stored for the first time. */
  ingested: number;
  /** Periods stored again with a higher revision (or corrected values at the same revision). */
  restated: number;
  /** Already stored with the same revision and values: not written again. */
  unchanged: number;
  /** Older than what is stored: ignored. */
  staleSkipped: number;
  quarantined: number;
  /** Cursor stored for the next run (completed runs only). */
  cursor?: string;
  error?: { code: string; message: string; attempts: number };
  /** The platform asked for a pause of this length (ms). */
  retryAfterMs?: number;
}

const hourFloor = (ms: number): number => Math.floor(ms / HOUR_MS) * HOUR_MS;
const dayFloor = (ms: number): number => Math.floor(ms / DAY_MS) * DAY_MS;

const keyOf = (o: MetricObservation): string =>
  [o.platform, o.accountId, o.campaignId, o.adsetId ?? '', o.adId ?? '', o.granularity, o.periodStart].join('|');

/**
 * The store keeps money as Decimal(18,6) and fractions as Float64, so a value read back can
 * differ from the one written in the last digits. Differences below 1e-6 are not a change:
 * treating them as one would rewrite (and re-roll-up) the same period on every pull.
 */
const MEASURE_EPSILON = 1e-6;

function sameMeasure(a: MetricObservation, b: MetricObservation): boolean {
  if (a.currency !== b.currency) return false;
  const keys = new Set([...Object.keys(a.metrics), ...Object.keys(b.metrics)] as (keyof MetricObservation['metrics'])[]);
  for (const k of keys) {
    const x = a.metrics[k];
    const y = b.metrics[k];
    if (x === undefined || y === undefined) {
      if (x !== y) return false;
    } else if (Math.abs(x - y) > MEASURE_EPSILON) {
      return false;
    }
  }
  return true;
}

/**
 * One sync run for one (platform, account): pull the observations the connector has
 * since the last successful cursor, validate them, store them, record the new cursor.
 *
 * Guarantees:
 * - Idempotent. Every page is compared with what is stored: identical periods are not
 *   written again, restated periods replace their earlier revision (the store keeps
 *   the highest revision per key). Pulling the same window twice changes nothing.
 * - The checkpoint advances only after every page is stored, so a crash anywhere in a
 *   run means the next run repeats the window (harmless, see above).
 * - Invalid observations never reach the metrics tables: they go to the quarantine
 *   with the reason, and the rest of the page is processed.
 * - Rate limits and transient failures are retried with backoff; a rate-limit hint is
 *   honoured. A failed run leaves the checkpoint untouched.
 */
export class SyncEngine {
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;

  constructor(private readonly deps: SyncEngineDeps) {
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.random = deps.random ?? Math.random;
  }

  async syncAccount(connector: PlatformConnector, account: ConnectorAccount): Promise<SyncOutcome> {
    const { clock, ids, options } = this.deps;
    const runId = ids.uuid();
    const startedMs = clock.now().getTime();
    const log = this.deps.logger.child({
      traceId: runId,
      workspaceId: options.workspaceId,
      platform: connector.platform,
      accountId: account.accountId,
    });
    const emitter = this.deps.emitter?.forTrace(runId);
    const key = {
      workspaceId: options.workspaceId,
      source: connector.platform,
      accountId: account.accountId,
      stream: options.granularity,
    };
    const outcome: SyncOutcome = {
      runId,
      platform: connector.platform,
      accountId: account.accountId,
      status: 'completed',
      window: { from: new Date(startedMs).toISOString(), to: new Date(startedMs).toISOString(), granularity: options.granularity },
      durationMs: 0,
      pages: 0,
      received: 0,
      ingested: 0,
      restated: 0,
      unchanged: 0,
      staleSkipped: 0,
      quarantined: 0,
    };
    const target = { type: 'ad_account', id: `${connector.platform}:${account.accountId}` };
    const actor = { type: 'service' as const, id: options.serviceName };
    const retryHooks = {
      sleep: this.sleep,
      random: this.random,
      onRetry: (info: { attempt: number; delayMs: number; code: string; message: string }) =>
        log.warn('sync step failed, retrying', { lifecycle: 'sync_retry', ...info }),
    };

    try {
      const caps = connector.capabilities();
      if (!caps.granularities.includes(options.granularity)) {
        throw new SyncStepError(
          `connector ${connector.platform}:${connector.adapter} does not offer ${options.granularity} data`,
          'invalid_request',
          1
        );
      }
      const checkpoint = await withRetry(() => this.deps.checkpoints.get(key), options.retry, retryHooks);
      outcome.window = this.buildWindow(caps.restatementWindowHours, caps.maxLookbackDays, checkpoint?.updatedAt, startedMs);
      const cursor = caps.supportsCursor ? checkpoint?.cursor : undefined;

      log.info('sync started', {
        lifecycle: 'sync_started',
        adapter: connector.adapter,
        window: outcome.window,
        resumedFromCheckpoint: checkpoint !== null,
      });
      await emitter?.emit({
        actor,
        workspaceId: options.workspaceId,
        action: 'metrics.fetch_started',
        category: 'metrics',
        outcome: 'success',
        target,
        details: { platform: connector.platform, accountId: account.accountId, adapter: connector.adapter, window: outcome.window, incremental: cursor !== undefined },
      });

      let pageToken: string | undefined;
      let nextCursor: string | undefined;
      const restatedPeriods: string[] = [];
      do {
        if (outcome.pages >= MAX_PAGES) throw new SyncStepError('connector returned too many pages', 'invalid_response', 1);
        const page = await withRetry(
          () =>
            connector.fetchObservations(account, {
              window: outcome.window,
              ...(cursor !== undefined ? { cursor } : {}),
              ...(pageToken !== undefined ? { pageToken } : {}),
              pageSize: Math.min(options.pageSize, caps.maxPageSize),
            }),
          options.retry,
          retryHooks
        );
        outcome.pages += 1;
        outcome.received += page.observations.length;
        nextCursor = page.nextCursor;

        const valid = await this.validate(page.observations, connector, account, runId, outcome, clock.isoNow());
        const toWrite = await withRetry(() => this.diff(valid, outcome, restatedPeriods), options.retry, retryHooks);
        if (toWrite.length > 0) {
          await withRetry(() => this.deps.metricsStore.upsertObservations(options.workspaceId, toWrite), options.retry, retryHooks);
        }
        pageToken = page.nextPageToken;
      } while (pageToken !== undefined);

      // Everything is durable: only now may the cursor move.
      if (nextCursor !== undefined) {
        await withRetry(() => this.deps.checkpoints.set(key, { cursor: nextCursor as string, runId }), options.retry, retryHooks);
        outcome.cursor = nextCursor;
      }
      outcome.durationMs = clock.now().getTime() - startedMs;

      if (outcome.ingested > 0) {
        await emitter?.emit({
          actor,
          workspaceId: options.workspaceId,
          action: 'metrics.ingested',
          category: 'metrics',
          outcome: 'success',
          target,
          details: { platform: connector.platform, accountId: account.accountId, count: outcome.ingested, window: outcome.window },
        });
      }
      if (outcome.restated > 0) {
        const sorted = [...restatedPeriods].sort();
        await emitter?.emit({
          actor,
          workspaceId: options.workspaceId,
          action: 'metrics.restated',
          category: 'metrics',
          outcome: 'success',
          target,
          details: {
            platform: connector.platform,
            accountId: account.accountId,
            count: outcome.restated,
            window: outcome.window,
            earliestPeriodStart: sorted[0],
            latestPeriodStart: sorted[sorted.length - 1],
          },
        });
      }
      await emitter?.emit({
        actor,
        workspaceId: options.workspaceId,
        action: 'metrics.fetch_completed',
        category: 'metrics',
        outcome: 'success',
        target,
        durationMs: outcome.durationMs,
        details: this.countsOf(outcome, connector),
      });
      log.info('sync completed', { lifecycle: 'sync_completed', ...this.countsOf(outcome, connector), durationMs: outcome.durationMs });
      if (outcome.quarantined > 0) {
        log.warn('observations quarantined', { lifecycle: 'sync_quarantined', quarantined: outcome.quarantined });
      }
      return outcome;
    } catch (err) {
      const step =
        err instanceof SyncStepError
          ? err
          : new SyncStepError(redactSecrets(err instanceof Error ? err.message : String(err)), 'error', 1, undefined, err);
      outcome.status = 'failed';
      outcome.durationMs = clock.now().getTime() - startedMs;
      outcome.error = { code: step.code, message: step.message, attempts: step.attempts };
      if (step.retryAfterMs !== undefined) outcome.retryAfterMs = step.retryAfterMs;
      log.error('sync failed', {
        lifecycle: 'sync_failed',
        errorCode: step.code,
        error: step.message,
        attempts: step.attempts,
        ...(step.retryAfterMs !== undefined ? { retryAfterMs: step.retryAfterMs } : {}),
        durationMs: outcome.durationMs,
      });
      await emitter?.emit({
        actor,
        workspaceId: options.workspaceId,
        action: 'metrics.fetch_failed',
        category: 'metrics',
        outcome: 'failure',
        target,
        errorCode: step.code,
        errorMessage: step.message,
        durationMs: outcome.durationMs,
        details: { ...this.countsOf(outcome, connector), attempts: step.attempts, ...(step.retryAfterMs !== undefined ? { retryAfterMs: step.retryAfterMs } : {}) },
      });
      return outcome;
    }
  }

  /** The span asked of the platform: everything since the last successful run, at least the restatement window. */
  private buildWindow(restatementWindowHours: number, maxLookbackDays: number, lastSuccessIso: string | undefined, nowMs: number): FetchWindow {
    const { granularity, initialLookbackHours } = this.deps.options;
    const earliestAllowed = nowMs - maxLookbackDays * DAY_MS;
    const wanted =
      lastSuccessIso === undefined
        ? nowMs - initialLookbackHours * HOUR_MS
        : Date.parse(lastSuccessIso) - Math.max(restatementWindowHours, 1) * HOUR_MS;
    const bounded = Math.max(wanted, earliestAllowed);
    // Daily periods are cut in the account's timezone, so the UTC-aligned window starts a day early
    // to contain the local day that straddles it. Re-pulled days are harmless (idempotent).
    const from = granularity === 'day' ? dayFloor(bounded) - DAY_MS : hourFloor(bounded);
    const to = granularity === 'day' ? nowMs : hourFloor(nowMs);
    return { from: new Date(from).toISOString(), to: new Date(Math.max(to, from + HOUR_MS)).toISOString(), granularity };
  }

  private countsOf(o: SyncOutcome, connector: PlatformConnector): Record<string, unknown> {
    return {
      platform: connector.platform,
      accountId: o.accountId,
      adapter: connector.adapter,
      window: o.window,
      pages: o.pages,
      received: o.received,
      ingested: o.ingested,
      restated: o.restated,
      unchanged: o.unchanged,
      staleSkipped: o.staleSkipped,
      quarantined: o.quarantined,
      durationMs: o.durationMs,
    };
  }

  /** Protocol validation plus the checks only the engine can make; failures go to the quarantine. */
  private async validate(
    raw: unknown[],
    connector: PlatformConnector,
    account: ConnectorAccount,
    runId: string,
    outcome: SyncOutcome,
    nowIso: string
  ): Promise<MetricObservation[]> {
    const valid: MetricObservation[] = [];
    const rejected: QuarantinedObservation[] = [];
    const reject = (value: unknown, reason: string, issues: { path: string; message: string }[]): void => {
      let payload = '';
      try {
        payload = JSON.stringify(value) ?? '';
      } catch {
        payload = '[unserialisable payload]';
      }
      if (payload.length > MAX_PAYLOAD_CHARS) payload = `${payload.slice(0, MAX_PAYLOAD_CHARS)}…[truncated]`;
      rejected.push({
        quarantineId: this.deps.ids.uuid(),
        workspaceId: this.deps.options.workspaceId,
        platform: connector.platform,
        accountId: account.accountId,
        runId,
        reason,
        issues,
        payload,
        quarantinedAt: nowIso,
      });
    };
    for (const value of raw) {
      const parsed = validateMetricObservation(value);
      if (!parsed.success) {
        reject(
          value,
          'schema_invalid',
          parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }))
        );
        continue;
      }
      const o = parsed.data as MetricObservation;
      if (o.platform !== connector.platform) {
        reject(value, 'platform_mismatch', [{ path: 'platform', message: `expected ${connector.platform}` }]);
      } else if (o.accountId !== account.accountId) {
        reject(value, 'account_mismatch', [{ path: 'accountId', message: 'observation belongs to another account' }]);
      } else {
        valid.push(o);
      }
    }
    if (rejected.length > 0) {
      await withRetry(() => this.deps.quarantine.add(rejected), this.deps.options.retry, {
        sleep: this.sleep,
        random: this.random,
      });
      outcome.quarantined += rejected.length;
    }
    return valid;
  }

  /** Keep only what changes the stored state: new periods, higher revisions, corrected values. */
  private async diff(valid: MetricObservation[], outcome: SyncOutcome, restatedPeriods: string[]): Promise<MetricObservation[]> {
    if (valid.length === 0) return [];
    // The counters are only touched at the end, so a retried diff cannot double them.
    const starts = valid.map((o) => Date.parse(o.periodStart));
    const from = new Date(Math.min(...starts)).toISOString();
    const to = new Date(Math.max(...starts) + 1).toISOString();
    const first = valid[0];
    const stored = await this.deps.metricsStore.queryObservations({
      workspaceId: this.deps.options.workspaceId,
      platform: first.platform,
      accountId: first.accountId,
      granularity: first.granularity,
      from,
      to,
      limit: 10_000,
    });
    const byKey = new Map(stored.map((o) => [keyOf(o), o]));
    const counts = { ingested: 0, restated: 0, unchanged: 0, staleSkipped: 0 };
    const periods: string[] = [];
    const toWrite: MetricObservation[] = [];
    // A page can repeat a key: the highest revision wins.
    const latest = new Map<string, MetricObservation>();
    for (const o of valid) {
      const k = keyOf(o);
      const seen = latest.get(k);
      if (!seen || o.revision > seen.revision) latest.set(k, o);
    }
    for (const [k, o] of latest) {
      const existing = byKey.get(k);
      if (!existing) {
        counts.ingested += 1;
        toWrite.push(o);
      } else if (o.revision < existing.revision) {
        counts.staleSkipped += 1;
      } else if (o.revision === existing.revision && sameMeasure(o, existing)) {
        counts.unchanged += 1;
      } else {
        counts.restated += 1;
        periods.push(o.periodStart);
        toWrite.push(o);
      }
    }
    outcome.ingested += counts.ingested;
    outcome.restated += counts.restated;
    outcome.unchanged += counts.unchanged;
    outcome.staleSkipped += counts.staleSkipped;
    restatedPeriods.push(...periods);
    return toWrite;
  }
}
