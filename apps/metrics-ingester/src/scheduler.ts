import type {
  ConnectorAccount,
  Clock,
  LeaseStore,
  Logger,
  MetricPlatform,
  PlatformConnector,
} from '@smallseedlabs/proba-audit-core';
import type { SyncEngine, SyncOutcome } from './sync-engine.js';

export interface SchedulerOptions {
  workspaceId: string;
  /** Default time between the end of one sync and the start of the next, per (platform, account). */
  intervalMs: number;
  /** Per-platform overrides of intervalMs (INGEST_INTERVAL_OVERRIDES). */
  intervalOverridesMs: Partial<Record<MetricPlatform, number>>;
  /** Each delay is spread by +/- this fraction so accounts do not hit the platform in lockstep. */
  jitterRatio: number;
  /** After a failed run the delay grows (interval * 2^failures) up to this cap. */
  failureBackoffMaxMs: number;
  /** How often listAccounts is called again to pick up accounts that were added or removed. */
  accountRefreshMs: number;
  /** A lease older than this is considered abandoned (a hung run) and may be taken over by any instance. */
  leaseTtlMs?: number;
}

export interface SchedulerDeps {
  connectors: ReadonlyMap<MetricPlatform, PlatformConnector>;
  engine: SyncEngine;
  /**
   * At most one sync per (platform, account) at a time: with a shared LeaseStore (LEASE_STORE=redis) that holds across
   * replicas, with the in-memory one inside this process only.
   */
  leases: LeaseStore;
  /** Owner id of this instance's leases; unique per process (Runtime.instanceId). */
  ownerId: string;
  clock: Clock;
  logger: Logger;
  options: SchedulerOptions;
  random?: () => number;
}

interface Task {
  platform: MetricPlatform;
  account: ConnectorAccount;
  failures: number;
  timer?: ReturnType<typeof setTimeout>;
  stopped: boolean;
}

/** Delay before the next run: the interval, spread by jitter; grown exponentially after failures; never below a platform hint. */
export function nextDelayMs(input: {
  intervalMs: number;
  jitterRatio: number;
  failures: number;
  failureBackoffMaxMs: number;
  retryAfterMs?: number;
  random: () => number;
}): number {
  const base =
    input.failures > 0
      ? Math.min(input.failureBackoffMaxMs, input.intervalMs * 2 ** Math.min(input.failures, 20))
      : input.intervalMs;
  const jitter = 1 + (input.random() * 2 - 1) * input.jitterRatio;
  return Math.max(Math.round(base * jitter), input.retryAfterMs ?? 0, 1);
}

/**
 * Runs one SyncEngine loop per (platform, account) of every configured connector.
 * Runs of the same account never overlap (lease, also between replicas when the LeaseStore is shared);
 * different accounts run concurrently. Two replicas on one shared LeaseStore both schedule every account, but a
 * sync only runs on the replica that holds its lease at that moment, so the platform is not pulled twice.
 */
export class IngestScheduler {
  private readonly tasks = new Map<string, Task>();
  private readonly random: () => number;
  private refreshTimer?: ReturnType<typeof setTimeout>;
  private running = false;
  private readonly inFlight = new Set<Promise<unknown>>();

  constructor(private readonly deps: SchedulerDeps) {
    this.random = deps.random ?? Math.random;
  }

  /** Names of the tasks currently scheduled, as `platform:accountId`. */
  taskIds(): string[] {
    return [...this.tasks.keys()].sort();
  }

  intervalFor(platform: MetricPlatform): number {
    return this.deps.options.intervalOverridesMs[platform] ?? this.deps.options.intervalMs;
  }

  /** Discover accounts and start the loops. */
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    await this.refreshAccounts();
  }

  /** Stop scheduling and wait for runs that are in flight. */
  async stop(): Promise<void> {
    this.running = false;
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    for (const t of this.tasks.values()) {
      t.stopped = true;
      if (t.timer) clearTimeout(t.timer);
    }
    await Promise.allSettled([...this.inFlight]);
  }

  /** Discover accounts now: add loops for new ones, stop loops of removed ones. */
  async refreshAccounts(): Promise<void> {
    const { connectors, logger, options } = this.deps;
    const seen = new Set<string>();
    const failedListings = new Set<MetricPlatform>();
    for (const [platform, connector] of connectors) {
      let accounts: ConnectorAccount[];
      try {
        accounts = await connector.listAccounts(options.workspaceId);
      } catch (err) {
        logger.error('listing accounts failed', { lifecycle: 'accounts_failed', platform, err });
        failedListings.add(platform);
        continue;
      }
      for (const account of accounts) {
        const id = `${platform}:${account.accountId}`;
        seen.add(id);
        const existing = this.tasks.get(id);
        if (existing) {
          existing.account = account; // timezone or currency may have changed
          continue;
        }
        const task: Task = { platform, account, failures: 0, stopped: false };
        this.tasks.set(id, task);
        logger.info('account scheduled', { lifecycle: 'account_scheduled', platform, accountId: account.accountId, intervalMs: this.intervalFor(platform) });
        // First run after a random fraction of the interval, so accounts spread out from the start.
        this.schedule(task, Math.round(this.random() * Math.min(this.intervalFor(platform), 5_000)));
      }
    }
    // An account only disappears when its platform listing worked in this refresh.
    for (const [id, task] of this.tasks) {
      if (!seen.has(id) && !failedListings.has(task.platform)) {
        task.stopped = true;
        if (task.timer) clearTimeout(task.timer);
        this.tasks.delete(id);
        logger.info('account unscheduled', { lifecycle: 'account_unscheduled', platform: task.platform, accountId: task.account.accountId });
      }
    }
    if (this.running) {
      if (this.refreshTimer) clearTimeout(this.refreshTimer);
      this.refreshTimer = setTimeout(() => {
        const p = this.refreshAccounts().catch(() => undefined);
        this.inFlight.add(p);
        void p.finally(() => this.inFlight.delete(p));
      }, options.accountRefreshMs);
    }
  }

  /**
   * Run one sync for the account now (used by the timers, and directly by tests and tools).
   * Returns null when a run for the same account is already in progress.
   */
  async syncNow(platform: MetricPlatform, accountId: string): Promise<SyncOutcome | null> {
    const task = this.tasks.get(`${platform}:${accountId}`);
    const connector = this.deps.connectors.get(platform);
    if (!task || !connector) throw new Error(`no scheduled account ${platform}:${accountId}`);
    return this.runTask(task, connector);
  }

  private async runTask(task: Task, connector: PlatformConnector): Promise<SyncOutcome | null> {
    const { logger, options } = this.deps;
    const leaseKey = `ingest:${task.platform}:${task.account.accountId}`;
    const ttl = options.leaseTtlMs ?? Math.max(this.intervalFor(task.platform) * 5, 5 * 60_000);
    const { leases, ownerId } = this.deps;
    try {
      if (!(await leases.tryAcquire(leaseKey, ownerId, ttl))) {
        logger.warn('sync skipped: previous run still in progress', {
          lifecycle: 'sync_skipped_overlap',
          platform: task.platform,
          accountId: task.account.accountId,
        });
        return null;
      }
    } catch (err) {
      // Fail closed: without the lease store nobody can say the account is free. The loop tries again at its next interval.
      logger.error('sync skipped: lease store unavailable', {
        lifecycle: 'sync_skipped_lease_unavailable',
        platform: task.platform,
        accountId: task.account.accountId,
        err,
      });
      return null;
    }
    try {
      const outcome = await this.deps.engine.syncAccount(connector, task.account);
      task.failures = outcome.status === 'failed' ? task.failures + 1 : 0;
      return outcome;
    } finally {
      await leases.release(leaseKey, ownerId).catch((err: unknown) => {
        logger.warn('lease release failed; it will expire on its own', { lifecycle: 'lease_release_failed', leaseKey, err });
      });
    }
  }

  private schedule(task: Task, delayMs: number): void {
    if (!this.running || task.stopped) return;
    task.timer = setTimeout(() => {
      const connector = this.deps.connectors.get(task.platform);
      if (!connector || task.stopped) return;
      const p = this.runTask(task, connector)
        .then((outcome) => {
          const next = nextDelayMs({
            intervalMs: this.intervalFor(task.platform),
            jitterRatio: this.deps.options.jitterRatio,
            failures: task.failures,
            failureBackoffMaxMs: this.deps.options.failureBackoffMaxMs,
            retryAfterMs: outcome?.retryAfterMs,
            random: this.random,
          });
          this.schedule(task, next);
        })
        .catch((err: unknown) => {
          // The engine reports failures as outcomes; this is a bug. Keep the loop alive.
          this.deps.logger.error('sync loop error', { lifecycle: 'sync_loop_error', platform: task.platform, err });
          task.failures += 1;
          this.schedule(task, this.deps.options.failureBackoffMaxMs);
        });
      this.inFlight.add(p);
      void p.finally(() => this.inFlight.delete(p));
    }, delayMs);
  }
}
