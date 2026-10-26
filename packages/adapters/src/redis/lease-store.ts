import { createClient } from 'redis';
import type { LeaseStore, Logger } from '@smallseedlabs/proba-audit-core';

type RedisClient = ReturnType<typeof createClient>;

export interface RedisLeaseStoreOptions {
  url: string;
  /** Prefix of every key, so deployments can share a Redis. */
  keyPrefix?: string;
  connectTimeoutMs?: number;
  logger?: Logger;
}

// The value of the key is the owner id. Release and renew compare it first, in one atomic step, so an owner whose lease
// expired (and was taken by someone else) can never delete or extend the new owner's lease.
const RELEASE_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;
const RENEW_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('PEXPIRE', KEYS[1], ARGV[2])
end
return 0
`;

/**
 * LeaseStore on Redis: `SET key owner NX PX ttl` to acquire, compare-and-delete / compare-and-expire scripts to release and renew.
 * Shared by every replica that uses the same Redis. Unlike the rate limiter it fails CLOSED: when Redis cannot be reached the
 * call throws, and the caller does not start work that needs exclusivity (the work is retried later).
 *
 * A single Redis is not a consensus system: after a failover to a replica that missed the write, two owners can briefly hold the
 * same key. The work protected here is idempotent or re-verifiable (metrics are revision-ordered, a chain is checked by verifyChain),
 * so this is an efficiency and consistency aid, not the only line of defence.
 */
export class RedisLeaseStore implements LeaseStore {
  private readonly client: RedisClient;
  private connecting?: Promise<void>;

  constructor(private readonly options: RedisLeaseStoreOptions) {
    const timeoutMs = options.connectTimeoutMs ?? 3000;
    this.client = createClient({
      url: options.url,
      // Answer immediately when Redis is away (the caller then does not start the work) instead of queueing commands.
      disableOfflineQueue: true,
      socket: { connectTimeout: timeoutMs, reconnectStrategy: (retries) => Math.min(retries * 200, 5000) },
    });
    this.client.on('error', (err) => options.logger?.error('lease store redis error', { err }));
  }

  async tryAcquire(key: string, ownerId: string, ttlMs: number): Promise<boolean> {
    await this.connect();
    const reply = await this.withTimeout(this.client.set(this.key(key), ownerId, { NX: true, PX: Math.max(1, Math.ceil(ttlMs)) }));
    return reply === 'OK';
  }

  async release(key: string, ownerId: string): Promise<boolean> {
    await this.connect();
    const reply = await this.withTimeout(this.client.eval(RELEASE_SCRIPT, { keys: [this.key(key)], arguments: [ownerId] }));
    return Number(reply) === 1;
  }

  async renew(key: string, ownerId: string, ttlMs: number): Promise<boolean> {
    await this.connect();
    const reply = await this.withTimeout(
      this.client.eval(RENEW_SCRIPT, { keys: [this.key(key)], arguments: [ownerId, String(Math.max(1, Math.ceil(ttlMs)))] })
    );
    return Number(reply) === 1;
  }

  async ping(): Promise<void> {
    await this.connect();
    await this.withTimeout(this.client.ping());
  }

  async close(): Promise<void> {
    if (!this.client.isOpen) return;
    if (this.client.isReady) {
      await this.client.quit().catch(() => this.client.disconnect());
    } else {
      await this.client.disconnect();
    }
  }

  private key(key: string): string {
    return `${this.options.keyPrefix ?? 'proba:audit:lease'}:${key}`;
  }

  private async connect(): Promise<void> {
    if (this.client.isReady) return;
    // Concurrent first calls share one connect(); with the offline queue off, a command sent before the client is ready would fail.
    this.connecting ??= this.withTimeout(this.client.connect()).then(
      () => undefined,
      (err) => {
        this.connecting = undefined;
        throw err;
      }
    );
    await this.connecting;
  }

  private withTimeout<T>(promise: Promise<T>): Promise<T> {
    let timer: NodeJS.Timeout;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Redis did not answer in time')), this.options.connectTimeoutMs ?? 3000);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
  }
}
