import { createClient } from 'redis';
import {
  dlqTopic,
  type BusMessage,
  type Clock,
  type DeadLetter,
  type EventBus,
  type Logger,
  type PublishOptions,
  type ReadOptions,
  type ReclaimOptions,
  type SubscribeOptions,
  type Subscription,
  type TrimOptions,
} from '@smallseedlabs/proba-audit-core';
import { SystemClock } from '../runtime/system.js';
import { redisClientOptions } from './connection.js';

type RedisClient = ReturnType<typeof createClient>;

export interface RedisStreamsOptions {
  /** `redis://[user]:password@host:port`, or `rediss://` for TLS. */
  url: string;
  /** Give up on the first connection after this long. Default 5000. Later outages reconnect forever. */
  connectTimeoutMs?: number;
  /** ping() fails if Redis does not answer within this time. Default 3000. */
  pingTimeoutMs?: number;
  clock?: Clock;
  logger?: Logger;
}

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

type StreamFields = Record<string, string>;

interface StreamId {
  ms: number;
  seq: number;
}

const ZERO_ID: StreamId = { ms: 0, seq: 0 };
/** One maxLength trim reads at most this many ids; a bigger excess is trimmed over several calls. */
const MAX_LENGTH_TRIM_PAGE = 10_001;

function parseStreamId(id: string): StreamId {
  const [ms, seq] = id.split('-');
  return { ms: Number(ms), seq: Number(seq ?? 0) };
}

function formatStreamId(id: StreamId): string {
  return `${id.ms}-${id.seq}`;
}

function compareStreamIds(a: StreamId, b: StreamId): number {
  return a.ms !== b.ms ? a.ms - b.ms : a.seq - b.seq;
}

function parseEntry<T>(topic: string, id: string, fields: StreamFields, deliveryCount: number): BusMessage<T> {
  return {
    id,
    topic,
    payload: JSON.parse(fields.data) as T,
    ...(fields.key ? { key: fields.key } : {}),
    publishedAt: fields.publishedAt,
    deliveryCount,
  };
}

/**
 * EventBus on Redis Streams: XADD to publish, consumer groups (XREADGROUP) to
 * share work, XACK to acknowledge, XPENDING + XCLAIM to retry stuck messages,
 * and a `<topic>.dlq` stream for dead letters.
 *
 * Durability depends on Redis persistence (docker-compose runs it with AOF on). Publishing never trims: the stream shrinks only
 * through trimAcknowledged(), which removes nothing a consumer group has not acknowledged.
 * Each subscription uses its own connection because XREADGROUP BLOCK holds one.
 */
export class RedisStreamsEventBus implements EventBus {
  private readonly client: RedisClient;
  private readonly clock: Clock;
  private readonly subscriptions = new Set<RedisSubscription>();
  private connecting?: Promise<void>;

  constructor(private readonly options: RedisStreamsOptions) {
    this.clock = options.clock ?? new SystemClock();
    this.client = createClient(redisClientOptions(options.url));
    this.client.on('error', (err) => this.options.logger?.error('redis client error', { err }));
  }

  /** Connects once; every method calls this first. */
  async connect(): Promise<void> {
    if (this.client.isOpen) return;
    // node-redis retries a failed first connection forever; fail fast instead so a
    // wrong REDIS_URL surfaces at startup. Once connected it reconnects on outages.
    this.connecting ??= withTimeout(this.client.connect(), this.options.connectTimeoutMs ?? 5000, 'Redis connect').then(
      () => undefined,
      async (err) => {
        this.connecting = undefined;
        await this.client.disconnect().catch(() => undefined);
        throw err;
      }
    );
    await this.connecting;
  }

  async publish(topic: string, payload: unknown, options: PublishOptions = {}): Promise<string> {
    await this.connect();
    return this.xadd(this.client, topic, payload, options);
  }

  async publishBatch(topic: string, payloads: unknown[], options: PublishOptions = {}): Promise<string[]> {
    await this.connect();
    if (payloads.length === 0) return [];
    // MULTI keeps the batch contiguous and in order.
    const multi = this.client.multi();
    for (const p of payloads) this.queueAdd(multi, topic, p, options);
    const ids = await multi.exec();
    return ids.map((id) => String(id));
  }

  async subscribe(options: SubscribeOptions): Promise<Subscription> {
    await this.connect();
    try {
      await this.client.xGroupCreate(options.topic, options.group, options.startFrom === 'latest' ? '$' : '0', {
        MKSTREAM: true,
      });
    } catch (err) {
      if (!(err instanceof Error) || !err.message.includes('BUSYGROUP')) throw err;
    }
    const reader = this.client.duplicate();
    reader.on('error', (err) => this.options.logger?.error('redis reader error', { err }));
    await reader.connect();
    const sub = new RedisSubscription(this.client, reader, this.clock, options, (s) => this.subscriptions.delete(s));
    this.subscriptions.add(sub);
    return sub;
  }

  async listDeadLetters<T = unknown>(topic: string, options: { max?: number } = {}): Promise<DeadLetter<T>[]> {
    await this.connect();
    const entries = await this.client.xRange(dlqTopic(topic), '-', '+', { COUNT: options.max ?? 100 });
    return entries.map((e) => ({
      id: e.id,
      topic,
      originalId: e.message.originalId,
      group: e.message.group,
      payload: JSON.parse(e.message.data) as T,
      reason: e.message.reason,
      deliveryCount: Number(e.message.deliveries),
      deadAt: e.message.deadAt,
    }));
  }

  /**
   * Trims the stream of messages that EVERY consumer group has acknowledged (XTRIM MINID), never anything else.
   *
   * For each group the safe bound is the oldest id still in its pending list (delivered, not acked), or, with nothing pending,
   * just past its last-delivered-id (so everything the group has read was acked). The smallest bound over all groups caps the
   * trim: a message that is pending for, or not yet delivered to, any group is never removed. Messages are removed only if also
   * older than `maxAgeMs` (by Redis server time), or beyond `maxLength`. A stream with no group is left alone.
   * A group that stopped reading (a dead consumer group nobody deleted) holds the trim back: delete it with XGROUP DESTROY.
   */
  async trimAcknowledged(topic: string, options: TrimOptions): Promise<number> {
    await this.connect();
    let groups: Awaited<ReturnType<RedisClient['xInfoGroups']>>;
    try {
      groups = await this.client.xInfoGroups(topic);
    } catch (err) {
      if (err instanceof Error && /no such key/i.test(err.message)) return 0;
      throw err;
    }
    if (groups.length === 0) return 0;

    let safe: StreamId | undefined;
    for (const g of groups) {
      const name = String(g.name);
      const last = parseStreamId(String(g.lastDeliveredId));
      const summary = await this.client.xPending(topic, name);
      const first = summary.pending > 0 && summary.firstId ? parseStreamId(String(summary.firstId)) : undefined;
      // Nothing delivered yet: nothing is acknowledged. Otherwise everything up to and including the last delivered id is
      // acknowledged, except what is still pending.
      const bound: StreamId = first ?? (compareStreamIds(last, ZERO_ID) === 0 ? ZERO_ID : { ms: last.ms, seq: last.seq + 1 });
      if (!safe || compareStreamIds(bound, safe) < 0) safe = bound;
    }
    if (!safe || compareStreamIds(safe, ZERO_ID) === 0) return 0;

    const [serverSeconds, serverMicros] = await this.serverTime();
    const nowMs = serverSeconds * 1000 + Math.floor(serverMicros / 1000);
    // +1: a message published in the very millisecond of the cutoff counts as old enough for maxAgeMs 0.
    let cutoff: StreamId = { ms: Math.max(0, nowMs - Math.max(0, options.maxAgeMs) + 1), seq: 0 };
    if (options.maxLength !== undefined) {
      const length = await this.client.xLen(topic);
      const excess = length - options.maxLength;
      if (excess > 0) {
        // The first message to keep is the (excess + 1)th; read at most a bounded page per call, later calls continue.
        const page = await this.client.xRange(topic, '-', '+', { COUNT: Math.min(excess + 1, MAX_LENGTH_TRIM_PAGE) });
        const keep = page[page.length - 1];
        if (keep) {
          const keepId = parseStreamId(String(keep.id));
          if (compareStreamIds(keepId, cutoff) > 0) cutoff = keepId;
        }
      }
    }
    const trimTo = compareStreamIds(cutoff, safe) < 0 ? cutoff : safe;
    if (compareStreamIds(trimTo, ZERO_ID) === 0) return 0;
    const removed = await this.client.sendCommand<number>(['XTRIM', topic, 'MINID', formatStreamId(trimTo)]);
    return Number(removed);
  }

  async ping(): Promise<void> {
    await this.connect();
    await withTimeout(this.client.ping(), this.options.pingTimeoutMs ?? 3000, 'Redis ping');
  }

  async close(): Promise<void> {
    for (const s of [...this.subscriptions]) await s.close();
    if (this.client.isOpen) await this.client.quit();
  }

  private fields(payload: unknown, options: PublishOptions): StreamFields {
    return {
      data: JSON.stringify(payload),
      publishedAt: this.clock.isoNow(),
      ...(options.key ? { key: options.key } : {}),
    };
  }

  private async serverTime(): Promise<[number, number]> {
    const reply = await this.client.sendCommand<[string, string]>(['TIME']);
    return [Number(reply[0]), Number(reply[1])];
  }

  private xadd(client: RedisClient, topic: string, payload: unknown, options: PublishOptions): Promise<string> {
    return client.xAdd(topic, '*', this.fields(payload, options));
  }

  private queueAdd(multi: ReturnType<RedisClient['multi']>, topic: string, payload: unknown, options: PublishOptions): void {
    multi.xAdd(topic, '*', this.fields(payload, options));
  }
}

class RedisSubscription implements Subscription {
  readonly topic: string;
  readonly group: string;
  readonly consumer: string;
  private readonly maxDeliveries: number;
  private readonly claimIdleMs: number;
  private closed = false;

  constructor(
    private readonly client: RedisClient,
    private readonly reader: RedisClient,
    private readonly clock: Clock,
    options: SubscribeOptions,
    private readonly onClose: (s: RedisSubscription) => void
  ) {
    this.topic = options.topic;
    this.group = options.group;
    this.consumer = options.consumer;
    this.maxDeliveries = options.maxDeliveries ?? 5;
    this.claimIdleMs = options.claimIdleMs ?? 60_000;
  }

  async read<T = unknown>(options: ReadOptions = {}): Promise<BusMessage<T>[]> {
    const max = options.max ?? 100;
    const block = options.blockMs ?? 0;
    // BLOCK 0 in Redis means "forever"; the port's 0 means "do not wait".
    const reply = await this.reader.xReadGroup(
      this.group,
      this.consumer,
      { key: this.topic, id: '>' },
      block > 0 ? { COUNT: max, BLOCK: block } : { COUNT: max }
    );
    if (!reply) return [];
    return reply.flatMap((stream) => stream.messages.map((m) => parseEntry<T>(this.topic, m.id, m.message, 1)));
  }

  async ack(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    await this.client.xAck(this.topic, this.group, ids);
  }

  async reclaimPending<T = unknown>(options: ReclaimOptions = {}): Promise<BusMessage<T>[]> {
    const minIdle = options.minIdleMs ?? this.claimIdleMs;
    const pending = await this.client.xPendingRange(this.topic, this.group, '-', '+', options.max ?? 100, {
      IDLE: minIdle,
    });
    if (pending.length === 0) return [];

    const exhausted = pending.filter((p) => p.deliveriesCounter >= this.maxDeliveries);
    const retryable = pending.filter((p) => p.deliveriesCounter < this.maxDeliveries);

    if (exhausted.length > 0) {
      const entries = await this.fetchEntries(exhausted.map((p) => p.id));
      const counts = new Map(exhausted.map((p) => [p.id, p.deliveriesCounter]));
      await this.moveToDeadLetters(
        entries.map((m) => ({ ...m, deliveryCount: counts.get(m.id) ?? this.maxDeliveries })),
        `max deliveries (${this.maxDeliveries}) reached`
      );
      // Entries trimmed from the stream can no longer be read: drop them from the PEL.
      const found = new Set(entries.map((m) => m.id));
      const lost = exhausted.filter((p) => !found.has(p.id)).map((p) => p.id);
      await this.ack(lost);
    }

    if (retryable.length === 0) return [];
    const counts = new Map(retryable.map((p) => [p.id, p.deliveriesCounter]));
    const claimed = await this.client.xClaim(
      this.topic,
      this.group,
      this.consumer,
      minIdle,
      retryable.map((p) => p.id)
    );
    const out: BusMessage<T>[] = [];
    const lost: string[] = [];
    for (const [i, entry] of claimed.entries()) {
      if (!entry) {
        lost.push(retryable[i]?.id);
        continue;
      }
      // XCLAIM bumps the delivery counter by one.
      out.push(parseEntry<T>(this.topic, entry.id, entry.message, (counts.get(entry.id) ?? 1) + 1));
    }
    await this.ack(lost.filter(Boolean));
    return out;
  }

  async deadLetter(messages: BusMessage[], reason: string): Promise<void> {
    await this.moveToDeadLetters(messages, reason);
  }

  async pendingCount(): Promise<number> {
    const summary = await this.client.xPending(this.topic, this.group);
    return summary.pending;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.onClose(this);
    if (this.reader.isOpen) await this.reader.disconnect();
  }

  private async fetchEntries(ids: string[]): Promise<BusMessage[]> {
    const out: BusMessage[] = [];
    for (const id of ids) {
      const [entry] = await this.client.xRange(this.topic, id, id);
      if (entry) out.push(parseEntry(this.topic, entry.id, entry.message, 1));
    }
    return out;
  }

  private async moveToDeadLetters(messages: BusMessage[], reason: string): Promise<void> {
    if (messages.length === 0) return;
    const multi = this.client.multi();
    for (const m of messages) {
      multi.xAdd(dlqTopic(this.topic), '*', {
        data: JSON.stringify(m.payload),
        originalId: m.id,
        group: this.group,
        consumer: this.consumer,
        reason,
        deliveries: String(m.deliveryCount),
        deadAt: this.clock.isoNow(),
      });
      multi.xAck(this.topic, this.group, m.id);
    }
    await multi.exec();
  }
}
