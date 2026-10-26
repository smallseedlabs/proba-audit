import {
  MemoryLogger,
  type AuditDraft,
  type AuditEmitter,
  type AuditEvent,
  type CheckpointStore,
  type LeaseStore,
  type MetricsStore,
  type QuarantineStore,
} from '@smallseedlabs/proba-audit-core';
import {
  InMemoryCheckpointStore,
  InMemoryLeaseStore,
  InMemoryMetricsStore,
  InMemoryQuarantineStore,
  ManualClock,
  SequentialIdGenerator,
  StubPlatformConnector,
} from '@smallseedlabs/proba-audit-adapters';
import { IngestScheduler, type SchedulerOptions } from './scheduler.js';
import { SyncEngine, type SyncEngineOptions } from './sync-engine.js';

export const T0 = '2026-10-28T12:00:00.000Z';
export const HOUR = 3_600_000;

/** Records the drafts it is given, stamping the traceId of forTrace views, like the real emitter does. */
export class RecordingEmitter implements AuditEmitter {
  readonly drafts: (AuditDraft & { traceId?: string })[] = [];

  async emit(draft: AuditDraft): Promise<AuditEvent | null> {
    this.drafts.push(draft);
    return null;
  }

  forTrace(traceId: string): AuditEmitter {
    return { emit: async (draft) => this.emit({ ...draft, traceId: draft.traceId ?? traceId }), forTrace: (t) => this.forTrace(t) };
  }

  actions(): string[] {
    return this.drafts.map((d) => d.action);
  }
}

export interface HarnessOptions {
  metricsStore?: MetricsStore;
  checkpoints?: CheckpointStore;
  quarantine?: QuarantineStore;
  /** Share one LeaseStore between two harnesses to test two replicas. */
  leases?: LeaseStore;
  ownerId?: string;
  engine?: Partial<SyncEngineOptions>;
  scheduler?: Partial<SchedulerOptions>;
  stub?: Partial<ConstructorParameters<typeof StubPlatformConnector>[0]>;
  now?: string;
}

/** Everything the engine and scheduler need, on in-memory adapters and the stub, with a clock the test moves. */
export function makeHarness(options: HarnessOptions = {}) {
  const clock = new ManualClock(options.now ?? T0);
  const ids = new SequentialIdGenerator();
  const logger = new MemoryLogger();
  const emitter = new RecordingEmitter();
  const metricsStore = options.metricsStore ?? new InMemoryMetricsStore();
  const checkpoints = options.checkpoints ?? new InMemoryCheckpointStore(clock);
  const quarantine = options.quarantine ?? new InMemoryQuarantineStore();
  const sleeps: number[] = [];
  const connector = new StubPlatformConnector({
    platform: 'meta',
    clock,
    nodeEnv: 'test',
    restateEveryMinutes: 30,
    restateRevisions: 2,
    ...options.stub,
  });
  const engine = new SyncEngine({
    metricsStore,
    checkpoints,
    quarantine,
    emitter,
    clock,
    ids,
    logger,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    random: () => 1,
    options: {
      workspaceId: 'ws_test',
      serviceName: 'metrics-ingester',
      granularity: 'hour',
      initialLookbackHours: 24,
      pageSize: 100,
      retry: { maxAttempts: 3, baseMs: 100, maxMs: 1000, maxRateLimitWaitMs: 10_000 },
      ...options.engine,
    },
  });
  const leases = options.leases ?? new InMemoryLeaseStore(clock);
  const connectors = new Map([['meta' as const, connector]]);
  const scheduler = new IngestScheduler({
    connectors,
    engine,
    leases,
    ownerId: options.ownerId ?? 'ingester-1',
    clock,
    logger,
    random: () => 0.5,
    options: {
      workspaceId: 'ws_test',
      intervalMs: 60_000,
      intervalOverridesMs: {},
      jitterRatio: 0.1,
      failureBackoffMaxMs: 600_000,
      accountRefreshMs: 300_000,
      ...options.scheduler,
    },
  });
  return { clock, ids, logger, emitter, metricsStore, checkpoints, quarantine, leases, sleeps, connector, engine, scheduler, connectors };
}

export type Harness = ReturnType<typeof makeHarness>;
