/**
 * The audit consumer: bus -> validate -> dedupe -> chain -> durable write -> ack.
 *
 * Guarantees
 * - A message is acknowledged only after the AuditStore accepted its event (or
 *   after it was recognised as an identical duplicate, or dead-lettered).
 * - Redelivery is harmless: events already stored with identical content are
 *   skipped BEFORE chaining, so a duplicate never leaves a gap in the hash chain.
 * - An eventId that is already stored with different content is never written; it
 *   is dead-lettered with a reason and logged as an error.
 * - One hash chain per workspace, continued from a per-workspace head that is cached
 *   in memory and recovered from the store the first time a workspace is seen.
 *
 * Single writer: the cached chain heads assume that ONE consumer instance writes
 * to the store at a time (see docs/ARCHITECTURE.md). Run one replica.
 */

import {
  chainEvent,
  contentHash,
  prepareForStorage,
  sameContent,
  validateAuditEvent,
  type AuditEmitter,
  type AuditEvent,
  type AuditStore,
  type BusMessage,
  type ChainLink,
  type Clock,
  type EventBus,
  type IdGenerator,
  type Logger,
  type StoredAuditEvent,
  type Subscription,
} from '@smallseedlabs/proba-audit-core';

export interface AuditConsumerOptions {
  topic: string;
  group: string;
  consumerName: string;
  batchSize: number;
  blockMs: number;
  claimIdleMs: number;
  maxDeliveries: number;
  /** Reclaim pending messages of crashed consumers this often. */
  reclaimIntervalMs: number;
  /** Backoff after a failed batch (store down): starts here, doubles up to the max. */
  retryBaseMs: number;
  retryMaxMs: number;
  /** The service name of this consumer: events with this `service` are its own self-audit events. */
  serviceName: string;
  /** Workspace for self-audit events that belong to no workspace. */
  selfAuditWorkspaceId: string;
}

export interface AuditConsumerDeps {
  bus: EventBus;
  store: AuditStore;
  clock: Clock;
  ids: IdGenerator;
  logger: Logger;
  /** Self-audit emitter (should be created with failureMode 'swallow'). Omit to disable self-audit. */
  emitter?: AuditEmitter;
  options: AuditConsumerOptions;
}

export type DeadLetterKind = 'invalid_event' | 'conflict';

export interface BatchResult {
  received: number;
  /** Events written to the store. */
  written: number;
  /** Identical redeliveries skipped. */
  duplicates: number;
  /** Messages dead-lettered by this batch. */
  invalid: number;
  conflicts: number;
  /** Workspaces that got events written. */
  workspaces: string[];
}

interface DeadLetterItem {
  message: BusMessage;
  kind: DeadLetterKind;
  reason: string;
  event?: AuditEvent;
  issues?: { path: string; code: string }[];
}

interface Candidate {
  message: BusMessage;
  event: AuditEvent;
  /** The event as it will be stored (normalised, with derived tags). */
  prepared: AuditEvent;
}

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

function traceIdOf(payload: unknown): string | undefined {
  if (typeof payload === 'object' && payload !== null) {
    const id = (payload as { traceId?: unknown }).traceId;
    if (typeof id === 'string') return id;
  }
  return undefined;
}

export class AuditConsumer {
  private readonly o: AuditConsumerOptions;
  private readonly heads = new Map<string, ChainLink | null>();
  private subscription: Subscription | null = null;
  private running = false;
  private loop: Promise<void> | null = null;
  private wake: (() => void) | null = null;

  constructor(private readonly deps: AuditConsumerDeps) {
    this.o = deps.options;
  }

  /** Subscribe, creating the consumer group if needed. Idempotent. start() calls it; tests may call it to drive processBatch directly. */
  async attach(): Promise<Subscription> {
    this.subscription ??= await this.deps.bus.subscribe({
      topic: this.o.topic,
      group: this.o.group,
      consumer: this.o.consumerName,
      maxDeliveries: this.o.maxDeliveries,
      claimIdleMs: this.o.claimIdleMs,
    });
    return this.subscription;
  }

  /** Subscribe and start the processing loop. */
  async start(): Promise<void> {
    if (this.running) return;
    await this.attach();
    this.running = true;
    this.loop = this.run();
    this.deps.logger.info('audit consumer started', {
      lifecycle: 'consumer_started',
      topic: this.o.topic,
      group: this.o.group,
      consumer: this.o.consumerName,
    });
  }

  /**
   * Graceful shutdown: finish the batch in flight (its events are written and
   * acked), stop reading, close the subscription. Messages that were read but not
   * processed stay pending and are reclaimed by the next start.
   */
  async stop(): Promise<void> {
    if (!this.running && !this.loop && !this.subscription) return;
    this.running = false;
    this.wake?.();
    await this.loop;
    this.loop = null;
    await this.subscription?.close();
    this.subscription = null;
    this.deps.logger.info('audit consumer stopped', { lifecycle: 'consumer_stopped' });
  }

  /** Hash chain heads currently cached (for tests and diagnostics). */
  cachedHead(workspaceId: string): ChainLink | null | undefined {
    return this.heads.get(workspaceId);
  }

  /**
   * The stream or the consumer group vanished while we were running (for example
   * Redis was flushed, or someone deleted the stream). Redis answers NOGROUP to
   * every read until the group exists again.
   */
  private isMissingGroup(err: unknown): boolean {
    return err instanceof Error && err.message.includes('NOGROUP');
  }

  /**
   * Re-create the stream and consumer group (subscribe() does XGROUP CREATE ...
   * MKSTREAM). A new group starts at the beginning of the stream; anything that was
   * already stored is skipped as an identical redelivery, so a replay is safe.
   */
  private async recreateGroup(): Promise<void> {
    const old = this.subscription;
    this.subscription = null;
    await old?.close().catch(() => undefined);
    await this.attach();
    this.deps.logger.warn('consumer group was missing; recreated it', {
      lifecycle: 'group_recreated',
      topic: this.o.topic,
      group: this.o.group,
    });
  }

  private async run(): Promise<void> {
    let lastReclaim = 0;
    let idleBackoff = this.o.retryBaseMs;
    while (this.running) {
      try {
        const sub = this.subscription as Subscription;
        let messages: BusMessage[] = [];
        if (Date.now() - lastReclaim >= this.o.reclaimIntervalMs) {
          lastReclaim = Date.now();
          messages = await sub.reclaimPending({ max: this.o.batchSize });
          if (messages.length > 0) {
            this.deps.logger.warn('reclaimed pending messages', {
              count: messages.length,
              maxDeliveryCount: Math.max(...messages.map((m) => m.deliveryCount)),
            });
          }
        }
        if (messages.length === 0) messages = await sub.read({ max: this.o.batchSize, blockMs: this.o.blockMs });
        if (messages.length > 0) await this.processWithRetry(messages);
        idleBackoff = this.o.retryBaseMs;
      } catch (err) {
        let failure = err;
        if (this.isMissingGroup(err) && this.running) {
          try {
            await this.recreateGroup();
            idleBackoff = this.o.retryBaseMs;
            continue;
          } catch (recreateErr) {
            failure = recreateErr; // fall through to the normal backoff
          }
        }
        // The bus itself failed (for example Redis is down): back off and try again.
        this.deps.logger.error('consumer loop error', { err: failure, retryInMs: idleBackoff });
        await this.sleep(idleBackoff);
        idleBackoff = Math.min(idleBackoff * 2, this.o.retryMaxMs);
      }
    }
  }

  /**
   * Process a batch, retrying with backoff while the store is failing. The batch
   * is held in memory and nothing new is read meanwhile, so its messages are not
   * redelivered (and not counted toward maxDeliveries) during an outage.
   */
  private async processWithRetry(messages: BusMessage[]): Promise<void> {
    let delay = this.o.retryBaseMs;
    while (this.running) {
      try {
        await this.processBatch(messages);
        return;
      } catch (err) {
        this.deps.logger.error('batch failed, nothing acknowledged; retrying', {
          err,
          messages: messages.length,
          retryInMs: delay,
        });
        await this.sleep(delay);
        delay = Math.min(delay * 2, this.o.retryMaxMs);
      }
    }
  }

  /**
   * Process one batch of bus messages. Public so tests can drive the consumer
   * deterministically. Throws if the store or bus fails; in that case nothing from
   * this call is acknowledged.
   */
  async processBatch(messages: BusMessage[]): Promise<BatchResult> {
    const { store, ids, clock, logger: rootLogger } = this.deps;
    const sub = await this.attach();
    const batchId = ids.uuid();
    const logger = rootLogger.child({ batchId });
    const startedAt = clock.now().getTime();

    const deadLetters: DeadLetterItem[] = [];
    const toAck: BusMessage[] = [];
    let duplicates = 0;

    // 1. Validate with the protocol schema.
    const candidates: Candidate[] = [];
    for (const message of messages) {
      const parsed = validateAuditEvent(message.payload);
      if (!parsed.success) {
        const issues = parsed.error.issues.map((i) => ({ path: i.path.join('.'), code: i.code }));
        const reason = `invalid audit event: ${parsed.error.issues
          .slice(0, 5)
          .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
          .join('; ')}`;
        logger.error('invalid audit event, dead-lettering', {
          traceId: traceIdOf(message.payload),
          messageId: message.id,
          deliveryCount: message.deliveryCount,
          reason,
        });
        deadLetters.push({ message, kind: 'invalid_event', reason, issues });
        continue;
      }
      const event = parsed.data as AuditEvent;
      candidates.push({ message, event, prepared: prepareForStorage(event) });
    }

    // 2. Duplicates inside the batch: first wins.
    const unique = new Map<string, Candidate>();
    for (const c of candidates) {
      const first = unique.get(c.event.eventId);
      if (!first) {
        unique.set(c.event.eventId, c);
      } else if (sameContent(first.prepared, c.prepared)) {
        duplicates += 1;
        toAck.push(c.message);
      } else {
        deadLetters.push(this.conflict(logger, c, contentHash(first.prepared), 'earlier in the same batch'));
      }
    }

    // 3. Duplicates against the store. Done BEFORE chaining so a skipped duplicate
    //    can never leave a gap in the chain.
    const existing = new Map<string, StoredAuditEvent>();
    if (unique.size > 0) {
      const found = await store.findExisting(
        [...unique.values()].map((c) => ({
          eventId: c.event.eventId,
          workspaceId: c.event.workspaceId,
          occurredAt: c.prepared.occurredAt,
        }))
      );
      for (const e of found) existing.set(e.eventId, e);
    }
    const fresh: Candidate[] = [];
    for (const c of unique.values()) {
      const stored = existing.get(c.event.eventId);
      if (!stored) {
        fresh.push(c);
      } else if (sameContent(stored, c.prepared)) {
        logger.debug('duplicate event skipped', { traceId: c.event.traceId, eventId: c.event.eventId });
        duplicates += 1;
        toAck.push(c.message);
      } else {
        deadLetters.push(this.conflict(logger, c, contentHash(stored), 'already stored'));
      }
    }

    // 4. Chain per workspace, in message order. Heads are only cached after the write succeeds.
    const heads = new Map<string, ChainLink | null>();
    const chained: StoredAuditEvent[] = [];
    const messageOf = new Map<string, BusMessage>();
    for (const c of fresh) {
      const ws = c.event.workspaceId;
      let head = heads.has(ws) ? (heads.get(ws) ?? null) : await this.headOf(ws, logger);
      const stored = chainEvent(c.event, head, clock.isoNow());
      head = { hash: stored.hash, ingestedAt: stored.ingestedAt };
      heads.set(ws, head);
      chained.push(stored);
      messageOf.set(stored.eventId, c.message);
    }

    // 5. Durable write. If this throws nothing has been acknowledged.
    const written = new Map<string, number>();
    if (chained.length > 0) {
      const result = await store.appendBatch(chained);
      if (result.inserted === chained.length) {
        for (const [ws, head] of heads) this.heads.set(ws, head);
      } else {
        // Someone else wrote these events between our check and our write. That breaks the
        // single-writer assumption, so the chain may have a gap: forget cached heads and shout.
        this.heads.clear();
        logger.error('chain integrity risk: store accepted fewer events than chained; another writer may be active', {
          chained: chained.length,
          inserted: result.inserted,
          duplicates: result.duplicates,
          conflicts: result.conflicts,
        });
      }
      const conflicted = new Set(result.conflicts);
      for (const e of chained) {
        const message = messageOf.get(e.eventId) as BusMessage;
        if (conflicted.has(e.eventId)) {
          const c = unique.get(e.eventId) as Candidate;
          deadLetters.push(this.conflict(logger, c, contentHash(e), 'stored by another writer meanwhile'));
        } else {
          toAck.push(message);
          written.set(e.workspaceId, (written.get(e.workspaceId) ?? 0) + 1);
        }
      }
      duplicates += result.duplicates;
    }

    // 6. Acknowledge what is durable, dead-letter the rest.
    if (toAck.length > 0) await sub.ack(toAck.map((m) => m.id));
    for (const d of deadLetters) await sub.deadLetter([d.message], d.reason);

    const result: BatchResult = {
      received: messages.length,
      written: [...written.values()].reduce((a, b) => a + b, 0),
      duplicates,
      invalid: deadLetters.filter((d) => d.kind === 'invalid_event').length,
      conflicts: deadLetters.filter((d) => d.kind === 'conflict').length,
      workspaces: [...written.keys()],
    };
    logger.info('batch processed', { ...result, durationMs: clock.now().getTime() - startedAt });

    // 7. Self-audit. Never affects the outcome of the batch.
    await this.selfAudit(batchId, startedAt, candidates, written, duplicates, deadLetters);
    return result;
  }

  private conflict(logger: Logger, c: Candidate, existingHash: string, where: string): DeadLetterItem {
    const incomingHash = contentHash(c.prepared);
    const reason = `eventId ${c.event.eventId} is ${where} with different content (existing content hash ${existingHash}, incoming ${incomingHash})`;
    logger.error('conflicting audit event, not written: same eventId with different content', {
      traceId: c.event.traceId,
      eventId: c.event.eventId,
      workspaceId: c.event.workspaceId,
      messageId: c.message.id,
      existingContentHash: existingHash,
      incomingContentHash: incomingHash,
    });
    return { message: c.message, kind: 'conflict', reason, event: c.event };
  }

  private async headOf(workspaceId: string, logger: Logger): Promise<ChainLink | null> {
    if (this.heads.has(workspaceId)) return this.heads.get(workspaceId) ?? null;
    const head = await this.deps.store.getChainHead(workspaceId);
    const link = head ? { hash: head.hash, ingestedAt: head.ingestedAt } : null;
    logger.info('chain head recovered from store', {
      workspaceId,
      headEventId: head?.eventId ?? null,
      headHash: head?.hash ?? null,
    });
    return link;
  }

  /**
   * The consumer audits itself through the same emitter and bus as everyone else:
   * one `system.audit_batch_processed` event per workspace written, and one
   * `system.audit_event_dead_lettered` event per dead letter.
   *
   * Loop guard: those events come back through this very consumer. A batch that
   * contains only the consumer's own events produces no batch event, so the
   * feedback stops after one hop. Dead letters are always reported.
   */
  private async selfAudit(
    batchId: string,
    startedAt: number,
    candidates: Candidate[],
    written: Map<string, number>,
    duplicates: number,
    deadLetters: DeadLetterItem[]
  ): Promise<void> {
    const { emitter, clock, logger } = this.deps;
    if (!emitter) return;
    const own = this.o.serviceName;
    const durationMs = clock.now().getTime() - startedAt;
    const batchEmitter = emitter.forTrace(this.deps.ids.uuid());
    const actor = { type: 'service' as const, id: own };

    try {
      const onlyOwn = candidates.length > 0 && candidates.every((c) => c.event.service === own);
      if (!onlyOwn) {
        for (const [workspaceId, count] of written) {
          await batchEmitter.emit({
            actor,
            workspaceId,
            action: 'system.audit_batch_processed',
            category: 'system',
            outcome: 'success',
            durationMs,
            details: { batchId, written: count, duplicatesInBatch: duplicates, deadLettered: deadLetters.length },
          });
        }
      }
      for (const d of deadLetters) {
        const scoped = d.event ? emitter.forTrace(d.event.traceId) : batchEmitter;
        await scoped.emit({
          actor,
          workspaceId: d.event?.workspaceId ?? this.o.selfAuditWorkspaceId,
          action: 'system.audit_event_dead_lettered',
          category: 'system',
          outcome: 'failure',
          riskLevel: d.kind === 'conflict' ? 'high' : 'medium',
          errorCode: d.kind,
          errorMessage: d.reason.slice(0, 500),
          target: { type: d.event ? 'audit_event' : 'bus_message', id: d.event?.eventId ?? d.message.id },
          details: {
            batchId,
            kind: d.kind,
            messageId: d.message.id,
            deliveryCount: d.message.deliveryCount,
            ...(d.issues ? { issues: d.issues } : {}),
          },
        });
      }
    } catch (err) {
      logger.error('self-audit failed', { err: new Error(errorMessage(err)), batchId });
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.wake = null;
        resolve();
      }, ms);
      this.wake = () => {
        clearTimeout(timer);
        this.wake = null;
        resolve();
      };
    });
  }
}
