/**
 * Test harness shared by the consumer's unit and integration tests: wires an
 * AuditConsumer to any bus and store, and offers helpers to publish events and
 * pump messages through the consumer deterministically.
 */
import { randomUUID } from 'node:crypto';
import {
  MemoryLogger,
  buildAuditEvent,
  createBusAuditEmitter,
  type AnchorStore,
  type LeaseStore,
  type AuditEvent,
  type AuditContentStore,
  type AuditStore,
  type BusMessage,
  type Clock,
  type EventBus,
  type IdGenerator,
  type Subscription,
} from '@smallseedlabs/proba-audit-core';
import { AuditConsumer, type AuditConsumerOptions } from './consumer.js';

export interface HarnessOptions {
  bus: EventBus;
  store: AuditStore;
  contentStore?: AuditContentStore;
  anchors?: AnchorStore;
  /** Share one LeaseStore between harnesses to test several consumer instances. */
  leases?: LeaseStore;
  clock: Clock;
  ids: IdGenerator;
  topic: string;
  group: string;
  selfAudit?: boolean;
  consumerName?: string;
  overrides?: Partial<AuditConsumerOptions>;
}

export function makeEvent(overrides: Partial<AuditEvent> = {}): AuditEvent {
  return buildAuditEvent({
    traceId: randomUUID(),
    workspaceId: 'seedbed',
    actor: { type: 'service', id: 'hub' },
    service: 'hub',
    action: 'command.received',
    category: 'command',
    outcome: 'success',
    occurredAt: '2026-10-25T10:00:00.000Z',
    details: { commandType: 'create_goal' },
    ...overrides,
  });
}

export class ConsumerHarness {
  readonly logger = new MemoryLogger();
  readonly consumer: AuditConsumer;
  private reader: Subscription | undefined;

  constructor(private readonly h: HarnessOptions) {
    const options: AuditConsumerOptions = {
      topic: h.topic,
      group: h.group,
      consumerName: h.consumerName ?? 'consumer-1',
      batchSize: 100,
      blockMs: 50,
      claimIdleMs: 60_000,
      maxDeliveries: 5,
      reclaimIntervalMs: 60_000,
      retryBaseMs: 10,
      retryMaxMs: 40,
      serviceName: 'audit-consumer',
      selfAuditWorkspaceId: 'seedbed',
      ...h.overrides,
    };
    this.consumer = new AuditConsumer({
      bus: h.bus,
      store: h.store,
      ...(h.contentStore ? { contentStore: h.contentStore } : {}),
      ...(h.anchors ? { anchors: h.anchors } : {}),
      ...(h.leases ? { leases: h.leases, leaseOwnerId: h.consumerName ?? 'consumer-1' } : {}),
      clock: h.clock,
      ids: h.ids,
      logger: this.logger,
      emitter:
        h.selfAudit === false
          ? undefined
          : createBusAuditEmitter({
              bus: h.bus,
              topic: h.topic,
              service: options.serviceName,
              defaultWorkspaceId: options.selfAuditWorkspaceId,
              clock: h.clock,
              ids: h.ids,
              logger: this.logger,
              failureMode: 'swallow',
            }),
      options,
    });
  }

  publish(...payloads: unknown[]): Promise<string[]> {
    return this.h.bus.publishBatch(this.h.topic, payloads);
  }

  /** Read what is available for the group (as a second consumer name) without processing it. */
  async read(max = 100): Promise<BusMessage[]> {
    this.reader ??= await this.h.bus.subscribe({ topic: this.h.topic, group: this.h.group, consumer: 'test-reader' });
    return this.reader.read({ max });
  }

  /** Read everything available and process it as one batch. */
  async pump(max = 100) {
    const messages = await this.read(max);
    return { messages, result: await this.consumer.processBatch(messages) };
  }

  async pending(): Promise<number> {
    const sub = await this.consumer.attach();
    return sub.pendingCount();
  }

  errors() {
    return this.logger.records.filter((r) => r.level === 'error');
  }

  async close(): Promise<void> {
    await this.consumer.stop();
    await this.reader?.close();
  }
}
