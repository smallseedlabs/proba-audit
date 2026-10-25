/**
 * Environment configuration, validated with zod (fail fast with a readable
 * message). Adapter names are plain strings here on purpose: they are checked
 * against the adapter registry when the adapter is created, so a new backend
 * needs no change to this schema.
 */

import { hostname } from 'node:os';
import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';
import { metricPlatformSchema, type MetricPlatform } from '@smallseedlabs/proba-protocol/audit';

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
  CHECKPOINT_STORE: nonEmpty('clickhouse'),
  QUARANTINE_STORE: nonEmpty('clickhouse'),

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

  // Audit consumer
  CONSUMER_RECLAIM_INTERVAL_MS: positiveInt(30000),
  CONSUMER_RETRY_BASE_MS: positiveInt(500),
  CONSUMER_RETRY_MAX_MS: positiveInt(30000),
  SELF_AUDIT_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  SELF_AUDIT_WORKSPACE_ID: nonEmpty('seedbed'),

  // Metrics ingestion (apps/metrics-ingester). PLATFORM_CONNECTORS is a list of
  // platform:adapter pairs (for example meta:stub,google:stub); empty ingests nothing.
  PLATFORM_CONNECTORS: z.string().default(''),
  // The stub connector (development data source) refuses to start in production unless this is true.
  ALLOW_STUB_CONNECTOR: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  INGEST_WORKSPACE_ID: nonEmpty('seedbed'),
  INGEST_INTERVAL_MS: positiveInt(60000),
  // Per-connector interval overrides, platform:ms pairs (for example meta:30000,google:120000).
  INGEST_INTERVAL_OVERRIDES: z.string().default(''),
  INGEST_JITTER_RATIO: z.coerce.number().min(0).max(1).default(0.1),
  INGEST_GRANULARITY: z.enum(['hour', 'day']).default('hour'),
  INGEST_INITIAL_LOOKBACK_HOURS: positiveInt(48),
  INGEST_MAX_ATTEMPTS: positiveInt(4),
  INGEST_RETRY_BASE_MS: positiveInt(1000),
  INGEST_RETRY_MAX_MS: positiveInt(30000),
  INGEST_MAX_RATE_LIMIT_WAIT_MS: positiveInt(60000),
  INGEST_FAILURE_BACKOFF_MAX_MS: positiveInt(600000),
  INGEST_ACCOUNT_REFRESH_MS: positiveInt(300000),
  INGEST_PAGE_SIZE: positiveInt(500),

  // Stub connector data (development data source)
  STUB_SEED: nonEmpty('proba-dev'),
  STUB_RESTATE_EVERY_MINUTES: positiveInt(30),
  STUB_RESTATE_REVISIONS: nonNegativeInt(2),
  STUB_FAILURE_RATE: z.coerce.number().min(0).max(1).default(0),

  // Rollup process (apps/rollup)
  ROLLUP_INTERVAL_MS: positiveInt(30000),
  ROLLUP_MAX_WINDOW_DAYS: positiveInt(7),

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
  adapters: {
    eventBus: string;
    auditStore: string;
    metricsStore: string;
    checkpointStore: string;
    quarantineStore: string;
  };
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
  consumer: {
    /** How often the consumer reclaims pending messages of crashed consumers. */
    reclaimIntervalMs: number;
    /** Backoff between retries of a batch the store rejected (doubles up to the max). */
    retryBaseMs: number;
    retryMaxMs: number;
    /** Emit the consumer's own audit events (processed batches, dead letters). */
    selfAudit: boolean;
    /** Workspace for self-audit events that belong to no workspace (for example an unparseable message). */
    selfAuditWorkspaceId: string;
  };
  /** Which ad platforms are ingested, and through which adapter. */
  connectors: {
    pairs: { platform: MetricPlatform; adapter: string }[];
    /** Explicit opt-in to run the stub connector in production. */
    allowStub: boolean;
    stub: { seed: string; restateEveryMinutes: number; restateRevisions: number; failureRate: number };
  };
  ingest: {
    workspaceId: string;
    intervalMs: number;
    /** Per-platform interval overrides. */
    intervalOverridesMs: Partial<Record<MetricPlatform, number>>;
    jitterRatio: number;
    granularity: 'hour' | 'day';
    initialLookbackHours: number;
    maxAttempts: number;
    retryBaseMs: number;
    retryMaxMs: number;
    maxRateLimitWaitMs: number;
    failureBackoffMaxMs: number;
    accountRefreshMs: number;
    pageSize: number;
  };
  rollup: { intervalMs: number; maxWindowDays: number };
  clickhouse: {
    url: string;
    username: string;
    password: string;
    database: string;
    migrationsDir: string;
  };
}

/** `meta:stub,google:stub` -> pairs. Each platform at most once; platforms come from the protocol enum. */
export function parsePlatformConnectors(value: string): { platform: MetricPlatform; adapter: string }[] {
  const pairs: { platform: MetricPlatform; adapter: string }[] = [];
  for (const raw of value.split(',').map((v) => v.trim()).filter(Boolean)) {
    const [platform, adapter, ...rest] = raw.split(':');
    const parsed = metricPlatformSchema.safeParse(platform);
    if (!parsed.success || !adapter || rest.length > 0 || !/^[a-z][a-z0-9-]*$/.test(adapter)) {
      throw new Error(`"${raw}" is not platform:adapter (platform one of ${metricPlatformSchema.options.join(', ')}; adapter like "stub")`);
    }
    if (pairs.some((p) => p.platform === parsed.data)) throw new Error(`platform "${parsed.data}" is listed twice`);
    pairs.push({ platform: parsed.data, adapter });
  }
  return pairs;
}

/** `meta:30000,google:120000` -> map of platform to ms. */
export function parseIntervalOverrides(value: string): Partial<Record<MetricPlatform, number>> {
  const out: Partial<Record<MetricPlatform, number>> = {};
  for (const raw of value.split(',').map((v) => v.trim()).filter(Boolean)) {
    const [platform, ms, ...rest] = raw.split(':');
    const parsed = metricPlatformSchema.safeParse(platform);
    const n = Number(ms);
    if (!parsed.success || rest.length > 0 || !Number.isInteger(n) || n <= 0) {
      throw new Error(`"${raw}" is not platform:milliseconds`);
    }
    out[parsed.data] = n;
  }
  return out;
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

  const issues: string[] = [];
  let pairs: { platform: MetricPlatform; adapter: string }[] = [];
  let overrides: Partial<Record<MetricPlatform, number>> = {};
  try {
    pairs = parsePlatformConnectors(e.PLATFORM_CONNECTORS);
  } catch (err) {
    issues.push(`PLATFORM_CONNECTORS: ${(err as Error).message}`);
  }
  try {
    overrides = parseIntervalOverrides(e.INGEST_INTERVAL_OVERRIDES);
  } catch (err) {
    issues.push(`INGEST_INTERVAL_OVERRIDES: ${(err as Error).message}`);
  }
  if (issues.length > 0) throw new ConfigError(issues);

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
    adapters: {
      eventBus: e.EVENT_BUS,
      auditStore: e.AUDIT_STORE,
      metricsStore: e.METRICS_STORE,
      checkpointStore: e.CHECKPOINT_STORE,
      quarantineStore: e.QUARANTINE_STORE,
    },
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
    consumer: {
      reclaimIntervalMs: e.CONSUMER_RECLAIM_INTERVAL_MS,
      retryBaseMs: e.CONSUMER_RETRY_BASE_MS,
      retryMaxMs: e.CONSUMER_RETRY_MAX_MS,
      selfAudit: e.SELF_AUDIT_ENABLED,
      selfAuditWorkspaceId: e.SELF_AUDIT_WORKSPACE_ID,
    },
    connectors: {
      pairs,
      allowStub: e.ALLOW_STUB_CONNECTOR,
      stub: {
        seed: e.STUB_SEED,
        restateEveryMinutes: e.STUB_RESTATE_EVERY_MINUTES,
        restateRevisions: e.STUB_RESTATE_REVISIONS,
        failureRate: e.STUB_FAILURE_RATE,
      },
    },
    ingest: {
      workspaceId: e.INGEST_WORKSPACE_ID,
      intervalMs: e.INGEST_INTERVAL_MS,
      intervalOverridesMs: overrides,
      jitterRatio: e.INGEST_JITTER_RATIO,
      granularity: e.INGEST_GRANULARITY,
      initialLookbackHours: e.INGEST_INITIAL_LOOKBACK_HOURS,
      maxAttempts: e.INGEST_MAX_ATTEMPTS,
      retryBaseMs: e.INGEST_RETRY_BASE_MS,
      retryMaxMs: e.INGEST_RETRY_MAX_MS,
      maxRateLimitWaitMs: e.INGEST_MAX_RATE_LIMIT_WAIT_MS,
      failureBackoffMaxMs: e.INGEST_FAILURE_BACKOFF_MAX_MS,
      accountRefreshMs: e.INGEST_ACCOUNT_REFRESH_MS,
      pageSize: e.INGEST_PAGE_SIZE,
    },
    rollup: { intervalMs: e.ROLLUP_INTERVAL_MS, maxWindowDays: e.ROLLUP_MAX_WINDOW_DAYS },
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
