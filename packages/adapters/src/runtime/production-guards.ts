import type { AppConfig, ClickHouseRole } from '@smallseedlabs/proba-audit-core';
import { parseRedisUrl } from '../redis/connection.js';

/**
 * Startup guards that only apply when NODE_ENV=production. Each one throws a descriptive error BEFORE any adapter is
 * created, so a misconfigured production process never serves traffic with an open Redis or an over-privileged ClickHouse user.
 */

export class RedisPasswordRequiredError extends Error {
  constructor(readonly users: string[]) {
    super(
      `Redis is used by ${users.join(', ')} but REDIS_URL carries no password. Production requires Redis authentication: ` +
        `use redis://<user>:<password>@host:6379 (rediss:// for TLS). Generate one with \`openssl rand -hex 24\`.`
    );
    this.name = 'RedisPasswordRequiredError';
  }
}

export class ClickHouseRoleError extends Error {
  constructor(
    readonly role: ClickHouseRole,
    readonly problems: string[]
  ) {
    super(
      `Refusing to start as ClickHouse role "${role}": ${problems.join('; ')}. ` +
        `The consumer and the api connect as their own least-privilege users (created by \`npm run migrate\`), never as the admin or migrator user.`
    );
    this.name = 'ClickHouseRoleError';
  }
}

export interface ProductionGuardOptions {
  /** audit-api: its rate limiter (AUDIT_API_RATE_LIMITER) may use Redis. */
  usesRateLimiter?: boolean;
  /** audit-consumer, metrics-ingester, rollup: their LEASE_STORE may use Redis. */
  usesLeases?: boolean;
  /** The ClickHouse role this process connects as. Omitted: the ClickHouse guard does not apply. */
  clickhouseRole?: ClickHouseRole;
}

/** The settings of this process that use Redis (they all read REDIS_URL). */
export function redisUsers(config: AppConfig, options: ProductionGuardOptions = {}): string[] {
  const users: string[] = [];
  if (config.adapters.eventBus === 'redis-streams') users.push('EVENT_BUS=redis-streams');
  if (options.usesLeases && config.adapters.leaseStore === 'redis') users.push('LEASE_STORE=redis');
  if (options.usesRateLimiter && config.api.adapters.rateLimiter === 'redis') users.push('AUDIT_API_RATE_LIMITER=redis');
  return users;
}

/** Production + a Redis adapter + a REDIS_URL without a password (or an unusable URL) = refuse to start. */
export function assertRedisAuthenticated(config: AppConfig, options: ProductionGuardOptions = {}): void {
  if (!config.isProduction) return;
  const users = redisUsers(config, options);
  if (users.length === 0) return;
  if (!parseRedisUrl(config.eventBus.redisUrl).hasPassword) throw new RedisPasswordRequiredError(users);
}

/** Names that are administrators in every ClickHouse install (and the packaged defaults). */
const ADMIN_USER_NAMES = new Set(['default', 'admin', 'root']);

const STORE_KEYS = ['auditStore', 'metricsStore', 'checkpointStore', 'quarantineStore', 'auditContentStore'] as const;

/**
 * A role user (CLICKHOUSE_<ROLE>_USER) without its password is refused in every environment: the connection could only fail.
 * In production, in addition, the consumer and the api must connect as their own user and not as the admin (CLICKHOUSE_USER) or
 * the migrator user, and need a password.
 */
export function assertClickHouseRoleSafe(config: AppConfig, options: ProductionGuardOptions = {}): void {
  const role = options.clickhouseRole;
  if (!role) return;
  if (!STORE_KEYS.some((key) => config.adapters[key] === 'clickhouse')) return;

  const creds = config.clickhouse.roles[role];
  const envPrefix = `CLICKHOUSE_${role.toUpperCase()}`;
  const problems: string[] = [];
  const ownUser = creds.username !== config.clickhouse.username; // otherwise the role falls back to the shared user (not in production)
  if (creds.password === '' && (config.isProduction || ownUser)) problems.push(`${envPrefix}_PASSWORD is empty`);

  if (config.isProduction && role !== 'migrator') {
    const forbidden = new Map<string, string>();
    for (const name of ADMIN_USER_NAMES) forbidden.set(name, 'a ClickHouse administrator name');
    forbidden.set(config.clickhouse.username, 'the admin user CLICKHOUSE_USER');
    forbidden.set(config.clickhouse.roles.migrator.username, 'the migrator user');
    if (role === 'api') forbidden.set(config.clickhouse.roles.consumer.username, 'the consumer (write) user');
    const why = forbidden.get(creds.username);
    if (why) problems.push(`${envPrefix}_USER "${creds.username}" is ${why}`);
  }

  if (problems.length > 0) throw new ClickHouseRoleError(role, problems);
}

/** Every production guard that needs no connection. createRuntime runs this first. */
export function assertProductionGuards(config: AppConfig, options: ProductionGuardOptions = {}): void {
  assertRedisAuthenticated(config, options);
  assertClickHouseRoleSafe(config, options);
}
