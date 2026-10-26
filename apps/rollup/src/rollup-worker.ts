import type {
  AuditEmitter,
  CheckpointKey,
  CheckpointStore,
  Clock,
  IdGenerator,
  LeaseStore,
  Logger,
  MetricsStore,
} from '@smallseedlabs/proba-audit-core';

const DAY_MS = 86_400_000;

export interface RollupWorkerOptions {
  workspaceId: string;
  serviceName: string;
  /** Pause between the end of one run and the start of the next. */
  intervalMs: number;
  /** A run recomputes at most this many days at a time (larger changed windows are split). */
  maxWindowDays: number;
  /** TTL of the run lease: a run that hangs longer than this may be replaced by another instance. Default max(5 intervals, 10 min). */
  leaseTtlMs?: number;
}

export interface RollupWorkerDeps {
  metricsStore: MetricsStore;
  /** Holds the watermark, so a restarted worker continues where the last one stopped. */
  checkpoints: CheckpointStore;
  /** One run at a time per workspace: across replicas when the LeaseStore is shared (LEASE_STORE=redis). */
  leases: LeaseStore;
  /** Owner id of this instance's lease; unique per process (Runtime.instanceId). */
  ownerId: string;
  emitter?: AuditEmitter;
  clock: Clock;
  ids: IdGenerator;
  logger: Logger;
  options: RollupWorkerOptions;
}

export interface RollupRunResult {
  status: 'idle' | 'completed' | 'failed';
  runId?: string;
  window?: { from: string; to: string };
  /** Observations written since the previous run, as reported by the store. */
  observationCount?: number;
  hourRows?: number;
  dayRows?: number;
  chunks?: number;
  durationMs?: number;
  error?: string;
}

/**
 * Keeps the hourly and daily rollups in step with the observations.
 *
 * Each run asks the MetricsStore which span of observations was written (or rewritten
 * by a restatement) since the stored watermark, and recomputes the hourly and daily
 * buckets that span touches, from the LATEST revision of every observation. A restated
 * observation therefore replaces its earlier revision in the sums; it is never added to
 * it, and running the same window again gives the same rows.
 *
 * Daily buckets are local days in each observation's `timezone` (UTC by default), summed
 * whole. `reach` is never summed. The watermark moves only after a run succeeds, so a
 * failed run is simply repeated. One run at a time (lease `rollup:<workspaceId>`): across replicas when the LeaseStore is shared, otherwise run ONE replica (see docs/ARCHITECTURE.md, "Metrics flow").
 */
export class RollupWorker {
  private timer?: ReturnType<typeof setTimeout>;
  private running = false;
  private current?: Promise<unknown>;

  constructor(private readonly deps: RollupWorkerDeps) {}

  private get key(): CheckpointKey {
    return { workspaceId: this.deps.options.workspaceId, source: 'rollup', accountId: '*', stream: 'changed_since' };
  }

  private get leaseKey(): string {
    return `rollup:${this.deps.options.workspaceId}`;
  }

  async runOnce(): Promise<RollupRunResult> {
    const { leases, ownerId, logger, options } = this.deps;
    const ttl = options.leaseTtlMs ?? Math.max(options.intervalMs * 5, 10 * 60_000);
    try {
      if (!(await leases.tryAcquire(this.leaseKey, ownerId, ttl))) return { status: 'idle' }; // overlap protection: one run at a time
    } catch (err) {
      // Fail closed: without the lease store nobody can say that no other run is going on. The next tick tries again.
      logger.error('rollup skipped: lease store unavailable', { lifecycle: 'rollup_skipped_lease_unavailable', err });
      return { status: 'idle' };
    }
    try {
      return await this.run();
    } finally {
      await leases.release(this.leaseKey, ownerId).catch((err: unknown) => {
        logger.warn('lease release failed; it will expire on its own', { lifecycle: 'lease_release_failed', err });
      });
    }
  }

  private async run(): Promise<RollupRunResult> {
    const { metricsStore, checkpoints, clock, ids, logger, options } = this.deps;
    const startedMs = clock.now().getTime();
    const runId = ids.uuid();
    const log = logger.child({ traceId: runId, workspaceId: options.workspaceId });
    const emitter = this.deps.emitter?.forTrace(runId);
    const actor = { type: 'service' as const, id: options.serviceName };

    let window: { from: string; to: string } | undefined;
    try {
      const previous = await checkpoints.get(this.key);
      const changed = await metricsStore.changedSince(options.workspaceId, previous?.cursor);
      if (!changed) {
        log.debug('rollup idle: nothing changed', { lifecycle: 'rollup_idle' });
        return { status: 'idle' };
      }
      window = { from: changed.from, to: changed.to };
      log.info('rollup started', { lifecycle: 'rollup_started', window, observationCount: changed.observationCount });

      let hourRows = 0;
      let dayRows = 0;
      let chunks = 0;
      const step = options.maxWindowDays * DAY_MS;
      const end = Date.parse(changed.to);
      for (let from = Date.parse(changed.from); from < end; from += step) {
        const to = Math.min(from + step, end);
        const request = { workspaceId: options.workspaceId, from: new Date(from).toISOString(), to: new Date(to).toISOString() };
        hourRows += await metricsStore.computeRollups({ bucket: 'hour', ...request });
        dayRows += await metricsStore.computeRollups({ bucket: 'day', ...request });
        chunks += 1;
      }

      await checkpoints.set(this.key, { cursor: changed.watermark, runId });
      const durationMs = clock.now().getTime() - startedMs;
      await emitter?.emit({
        actor,
        workspaceId: options.workspaceId,
        action: 'metrics.rollup_run',
        category: 'metrics',
        outcome: 'success',
        target: { type: 'metrics_rollups', id: options.workspaceId },
        durationMs,
        details: { period: window, observationCount: changed.observationCount, rows: { hour: hourRows, day: dayRows }, chunks },
      });
      log.info('rollup completed', { lifecycle: 'rollup_completed', window, hourRows, dayRows, chunks, durationMs });
      return { status: 'completed', runId, window, observationCount: changed.observationCount, hourRows, dayRows, chunks, durationMs };
    } catch (err) {
      const message = (err instanceof Error ? err.message : String(err)).slice(0, 500);
      const durationMs = clock.now().getTime() - startedMs;
      log.error('rollup failed', { lifecycle: 'rollup_failed', error: message, durationMs });
      await emitter?.emit({
        actor,
        workspaceId: options.workspaceId,
        action: 'metrics.rollup_run',
        category: 'metrics',
        outcome: 'failure',
        target: { type: 'metrics_rollups', id: options.workspaceId },
        errorCode: 'rollup_failed',
        errorMessage: message,
        durationMs,
        details: { ...(window ? { period: window } : {}) },
      });
      return { status: 'failed', runId, ...(window ? { window } : {}), error: message, durationMs };
    }
  }

  /** Run now, then every intervalMs (measured from the end of a run). */
  start(): void {
    if (this.running) return;
    this.running = true;
    const tick = (): void => {
      this.current = this.runOnce().finally(() => {
        if (this.running) this.timer = setTimeout(tick, this.deps.options.intervalMs);
      });
    };
    tick();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    await this.current?.catch(() => undefined);
  }
}
