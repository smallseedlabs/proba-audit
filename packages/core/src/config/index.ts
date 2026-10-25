/**
 * Environment configuration, validated with zod (fail fast with a readable
 * message). Adapter names are plain strings here on purpose: they are checked
 * against the adapter registry when the adapter is created, so a new backend
 * needs no change to this schema.
 */

import { hostname } from 'node:os';
import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';

const logLevels = ['trace', 'debug', 'info', 'warn', 'error', 'silent'] as const;

const positiveInt = (def: number) => z.coerce.number().int().positive().default(def);
const nonNegativeInt = (def: number) => z.coerce.number().int().nonnegative().default(def);
const nonEmpty = (def: string) => z.string().min(1).default(def);

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  SERVICE_NAME: z.string().min(1).optional(),
  HOST: nonEmpty('0.0.0.0'),
  PORT: nonNegativeInt(3100),
  LOG_LEVEL: z.enum(logLevels).default('info'),

  // Adapter selection (see docs/ARCHITECTURE.md for how to add one).
  EVENT_BUS: nonEmpty('redis-streams'),
  AUDIT_STORE: nonEmpty('clickhouse'),
  METRICS_STORE: nonEmpty('clickhouse'),

  // Redis Streams
  REDIS_URL: nonEmpty('redis://localhost:6379'),
  AUDIT_TOPIC: nonEmpty('proba.audit.events'),
  AUDIT_CONSUMER_GROUP: nonEmpty('audit-consumer'),
  CONSUMER_NAME: z.string().min(1).optional(),
  BUS_BATCH_SIZE: positiveInt(100),
  BUS_BLOCK_MS: nonNegativeInt(2000),
  BUS_CLAIM_IDLE_MS: nonNegativeInt(60000),
  BUS_MAX_DELIVERIES: positiveInt(5),
  BUS_MAX_STREAM_LENGTH: z.coerce.number().int().positive().optional(),

  // ClickHouse
  CLICKHOUSE_URL: nonEmpty('http://localhost:8123'),
  CLICKHOUSE_USER: nonEmpty('default'),
  CLICKHOUSE_PASSWORD: z.string().default(''),
  CLICKHOUSE_DATABASE: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).default('proba_audit'),
  CLICKHOUSE_MIGRATIONS_DIR: nonEmpty('migrations/clickhouse'),
});

export type Env = z.infer<typeof envSchema>;

export interface AppConfig {
  env: Env['NODE_ENV'];
  isDevelopment: boolean;
  isProduction: boolean;
  isTest: boolean;
  service: { name: string; host: string; port: number };
  log: { level: Env['LOG_LEVEL'] };
  /** Registry names of the selected adapters. */
  adapters: { eventBus: string; auditStore: string; metricsStore: string };
  eventBus: {
    redisUrl: string;
    auditTopic: string;
    consumerGroup: string;
    consumerName: string;
    batchSize: number;
    blockMs: number;
    claimIdleMs: number;
    maxDeliveries: number;
    maxStreamLength?: number;
  };
  clickhouse: {
    url: string;
    username: string;
    password: string;
    database: string;
    migrationsDir: string;
  };
}

export class ConfigError extends Error {
  constructor(readonly issues: string[]) {
    super(`Invalid configuration:\n${issues.map((i) => `  - ${i}`).join('\n')}`);
    this.name = 'ConfigError';
  }
}

export interface LoadConfigOptions {
  /** Default service name when SERVICE_NAME is not set (each app passes its own). */
  serviceName?: string;
  /** Default port when PORT is not set. */
  defaultPort?: number;
}

type EnvSource = Record<string, string | undefined>;

/** Parse and validate configuration from an env object (pure; no dotenv). */
export function loadConfig(env: EnvSource = process.env, options: LoadConfigOptions = {}): AppConfig {
  // Treat empty strings as unset so `FOO=` in a .env file falls back to the default.
  const cleaned: EnvSource = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && (value !== '' || key === 'CLICKHOUSE_PASSWORD')) cleaned[key] = value;
  }
  if (cleaned.PORT === undefined && options.defaultPort !== undefined) {
    cleaned.PORT = String(options.defaultPort);
  }

  const parsed = envSchema.safeParse(cleaned);
  if (!parsed.success) {
    throw new ConfigError(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`));
  }
  const e = parsed.data;

  return {
    env: e.NODE_ENV,
    isDevelopment: e.NODE_ENV === 'development',
    isProduction: e.NODE_ENV === 'production',
    isTest: e.NODE_ENV === 'test',
    service: {
      name: e.SERVICE_NAME ?? options.serviceName ?? 'proba-audit',
      host: e.HOST,
      port: e.PORT,
    },
    log: { level: e.LOG_LEVEL },
    adapters: { eventBus: e.EVENT_BUS, auditStore: e.AUDIT_STORE, metricsStore: e.METRICS_STORE },
    eventBus: {
      redisUrl: e.REDIS_URL,
      auditTopic: e.AUDIT_TOPIC,
      consumerGroup: e.AUDIT_CONSUMER_GROUP,
      consumerName: e.CONSUMER_NAME ?? `${hostname()}-${process.pid}`,
      batchSize: e.BUS_BATCH_SIZE,
      blockMs: e.BUS_BLOCK_MS,
      claimIdleMs: e.BUS_CLAIM_IDLE_MS,
      maxDeliveries: e.BUS_MAX_DELIVERIES,
      maxStreamLength: e.BUS_MAX_STREAM_LENGTH,
    },
    clickhouse: {
      url: e.CLICKHOUSE_URL,
      username: e.CLICKHOUSE_USER,
      password: e.CLICKHOUSE_PASSWORD,
      database: e.CLICKHOUSE_DATABASE,
      migrationsDir: e.CLICKHOUSE_MIGRATIONS_DIR,
    },
  };
}

/** Load a local .env file (if present), then validate process.env. */
export function loadConfigFromEnvironment(options: LoadConfigOptions = {}): AppConfig {
  loadDotenv();
  return loadConfig(process.env, options);
}

function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.password) u.password = '[REDACTED]';
    if (u.username && u.password) u.username = '[REDACTED]';
    return u.toString();
  } catch {
    return '[unparseable url]';
  }
}

/** Copy of the config that is safe to log: passwords and URL credentials removed. */
export function redactConfig(config: AppConfig): Record<string, unknown> {
  return {
    ...config,
    eventBus: { ...config.eventBus, redisUrl: redactUrl(config.eventBus.redisUrl) },
    clickhouse: {
      ...config.clickhouse,
      url: redactUrl(config.clickhouse.url),
      password: config.clickhouse.password ? '[REDACTED]' : '',
    },
  };
}
