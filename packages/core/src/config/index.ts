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
  AUDIT_CONTENT_STORE: nonEmpty('clickhouse'),
  // Signed heads of the hash chains, kept OUTSIDE the audit store so deleting the newest events is detectable (`tail_truncated`).
  // `postgres` needs ANCHOR_DATABASE_URL (a database the audit store's credentials cannot reach). Used by audit-consumer and audit-api.
  ANCHOR_STORE: nonEmpty('memory'),
  // HMAC key that signs the anchors. Required (at least 32 characters) in production; outside production an empty key falls back to a fixed development key.
  ANCHOR_HMAC_KEY: z.string().default(''),
  ANCHOR_DATABASE_URL: z.string().default(''),
  // Exclusive claims (leases) that keep replicas from doing the same work at once: one sync per ad account (metrics-ingester), one rollup run
  // per workspace (rollup), one writer per workspace chain (audit-consumer). `redis` (uses REDIS_URL) is shared by every replica; `memory` is per process.
  LEASE_STORE: nonEmpty('memory'),
  // The in-memory adapters lose everything on restart and are per process: they refuse to start in production
  // unless this is true (a deliberate, temporary opt-in, for example a smoke test of a production image).
  ALLOW_IN_MEMORY_ADAPTERS: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),

  // Raw text of audit events (AuditEvent.content). Off by default: the consumer then drops it (never stored, no
  // digest) and the read API never returns it. On: the consumer stores it in AUDIT_CONTENT_STORE and the API serves it to admins.
  AUDIT_CONTENT_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),

  // Redis Streams
  REDIS_URL: nonEmpty('redis://localhost:6379'),
  AUDIT_TOPIC: nonEmpty('proba.audit.events'),
  AUDIT_CONSUMER_GROUP: nonEmpty('audit-consumer'),
  CONSUMER_NAME: z.string().min(1).optional(),
  BUS_BATCH_SIZE: positiveInt(100),
  BUS_BLOCK_MS: nonNegativeInt(2000),
  BUS_CLAIM_IDLE_MS: nonNegativeInt(60000),
  BUS_MAX_DELIVERIES: positiveInt(5),
  // Optional ceiling on the audit stream length. The stream is trimmed by the audit-consumer, and ONLY of messages that every consumer
  // group has acknowledged: this ceiling never drops an unacknowledged message (the stream can exceed it while a group lags).
  BUS_MAX_STREAM_LENGTH: z.coerce.number().int().positive().optional(),
  // Acknowledged audit stream messages older than this are trimmed (audit-consumer). Unacknowledged ones stay however old they are.
  AUDIT_STREAM_MAX_AGE_HOURS: z.coerce.number().positive().default(72),
  // How often the audit-consumer trims the stream. 0 turns trimming off (the stream then grows without bound).
  AUDIT_STREAM_TRIM_INTERVAL_MS: nonNegativeInt(60000),

  // Audit consumer
  CONSUMER_RECLAIM_INTERVAL_MS: positiveInt(30000),
  // How long the audit-consumer's per-workspace write lease (LEASE_STORE) lives without being renewed; one batch is written well within it.
  CONSUMER_LEASE_TTL_MS: positiveInt(30000),
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

  // Read API (apps/audit-api). Adapter names are registry keys, like the ports above.
  AUDIT_API_TOKEN_VERIFIER: nonEmpty('firebase'),
  AUDIT_API_RATE_LIMITER: nonEmpty('memory'),
  AUDIT_API_SCOPE_SOURCE: nonEmpty('connectors'),
  // Firebase project whose ID tokens are accepted (iss/aud). The same variable proba-hub uses.
  FIREBASE_PROJECT_ID: z.string().default(''),
  // JSON array of { token, subject, email, emailVerified? }. Only for the `static` verifier, never in production.
  AUDIT_API_STATIC_TOKENS: z.string().default(''),
  AUDIT_API_WORKSPACE_ID: nonEmpty('seedbed'),
  // Who may call the API: a verified email in the allow-list or in an allowed domain gets `viewer`;
  // an email in the admin list gets `admin`. Nobody is allowed when all three are empty.
  AUDIT_API_ALLOWED_EMAILS: z.string().default(''),
  AUDIT_API_ALLOWED_EMAIL_DOMAINS: z.string().default(''),
  AUDIT_API_ADMIN_EMAILS: z.string().default(''),
  // Browser origins allowed by CORS (the portal). Empty: no cross-origin access.
  AUDIT_API_CORS_ORIGINS: z.string().default(''),
  // Trust X-Forwarded-For for the client address (rate limiting, logs). Only behind a proxy you control.
  AUDIT_API_TRUST_PROXY: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  AUDIT_API_RATE_LIMIT_MAX: positiveInt(120),
  AUDIT_API_RATE_LIMIT_WINDOW_MS: positiveInt(60000),
  // Chain verification reads a lot: its own, much lower limit per caller.
  AUDIT_API_CHAIN_RATE_LIMIT_MAX: positiveInt(6),
  // Rejected sign-ins allowed per client address per window before it is refused outright.
  AUDIT_API_AUTH_FAILURE_LIMIT_MAX: positiveInt(30),
  AUDIT_API_AUTH_FAILURE_WINDOW_MS: positiveInt(900000),
  // Which ad accounts a workspace sees for analytics: `connectors` asks the PLATFORM_CONNECTORS,
  // `static` uses AUDIT_API_ANALYTICS_ACCOUNTS (platform:accountId pairs).
  AUDIT_API_ANALYTICS_ACCOUNTS: z.string().default(''),
  AUDIT_API_SCOPE_CACHE_MS: positiveInt(60000),
  // Chain verification is bounded in time and in events.
  AUDIT_API_CHAIN_MAX_RANGE_HOURS: positiveInt(24),
  AUDIT_API_CHAIN_MAX_EVENTS: positiveInt(100000),

  // ClickHouse
  CLICKHOUSE_URL: nonEmpty('http://localhost:8123'),
  CLICKHOUSE_USER: nonEmpty('default'),
  CLICKHOUSE_PASSWORD: z.string().default(''),
  CLICKHOUSE_DATABASE: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).default('proba_audit'),
  CLICKHOUSE_MIGRATIONS_DIR: nonEmpty('migrations/clickhouse'),
  // Least-privilege ClickHouse users (scripts/clickhouse-roles.sql). Each role falls back to CLICKHOUSE_USER /
  // CLICKHOUSE_PASSWORD when its own user is not set, so a single-user local stack keeps working.
  CLICKHOUSE_CONSUMER_USER: z.string().min(1).optional(),
  CLICKHOUSE_CONSUMER_PASSWORD: z.string().min(1).optional(),
  CLICKHOUSE_API_USER: z.string().min(1).optional(),
  CLICKHOUSE_API_PASSWORD: z.string().min(1).optional(),
  CLICKHOUSE_MIGRATOR_USER: z.string().min(1).optional(),
  CLICKHOUSE_MIGRATOR_PASSWORD: z.string().min(1).optional(),
});

export type Env = z.infer<typeof envSchema>;

export interface StaticTokenEntry {
  token: string;
  subject: string;
  email: string;
  emailVerified: boolean;
}

const staticTokensSchema = z.array(
  z.object({
    token: z.string().min(8),
    subject: z.string().min(1).max(128),
    email: z.string().email(),
    emailVerified: z.boolean().default(true),
  })
);

/** `a@x.com, B@x.com` -> lower-case, trimmed, de-duplicated. */
export function parseList(value: string): string[] {
  return [...new Set(value.split(',').map((v) => v.trim().toLowerCase()).filter(Boolean))];
}

/** `meta:act_1,google:123` -> account refs, platforms from the protocol enum. */
export function parseAccountRefs(value: string): { platform: MetricPlatform; accountId: string }[] {
  const out: { platform: MetricPlatform; accountId: string }[] = [];
  for (const raw of value.split(',').map((v) => v.trim()).filter(Boolean)) {
    const index = raw.indexOf(':');
    const platform = metricPlatformSchema.safeParse(index < 0 ? raw : raw.slice(0, index));
    const accountId = index < 0 ? '' : raw.slice(index + 1);
    if (!platform.success || accountId === '' || accountId.length > 128) {
      throw new Error(`"${raw}" is not platform:accountId (platform one of ${metricPlatformSchema.options.join(', ')})`);
    }
    out.push({ platform: platform.data, accountId });
  }
  return out;
}

/** CORS origins must be exact origins: scheme://host[:port], never `*` and never with a path. */
export function parseCorsOrigins(value: string): string[] {
  const origins: string[] = [];
  for (const raw of value.split(',').map((v) => v.trim()).filter(Boolean)) {
    let origin: string;
    try {
      const u = new URL(raw);
      origin = u.origin;
      if (!/^https?:$/.test(u.protocol) || origin !== raw.replace(/\/$/, '')) throw new Error('not an origin');
    } catch {
      throw new Error(`"${raw}" is not an origin like https://insights.example.com (no wildcard, no path)`);
    }
    if (!origins.includes(origin)) origins.push(origin);
  }
  return origins;
}

/**
 * The ClickHouse users a process connects as: `consumer` writes (audit-consumer, metrics-ingester, rollup: INSERT and SELECT),
 * `api` only reads (audit-api: SELECT), `migrator` changes the schema (`npm run migrate`: DDL).
 */
export type ClickHouseRole = 'consumer' | 'api' | 'migrator';

/** The ClickHouse user each role has when CLICKHOUSE_<ROLE>_USER is not set in production (and the user the migrator creates). */
export const DEFAULT_CLICKHOUSE_ROLE_USERS: Record<ClickHouseRole, string> = {
  consumer: 'proba_consumer',
  api: 'proba_api',
  migrator: 'proba_migrator',
};

export interface ClickHouseCredentials {
  username: string;
  password: string;
}

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
    auditContentStore: string;
    anchorStore: string;
    leaseStore: string;
  };
  /** Chain anchors (ANCHOR_STORE): the key that signs them and the database of the `postgres` adapter. */
  anchors: { hmacKey: string; databaseUrl: string };
  /** Explicit opt-in to run in-memory adapters when NODE_ENV=production (see InMemoryAdaptersNotAllowedError). */
  allowInMemoryAdapters: boolean;
  /** Raw text of audit events: stored by the consumer and served (to admins) by the API only when enabled. */
  content: { enabled: boolean };
  eventBus: {
    redisUrl: string;
    auditTopic: string;
    consumerGroup: string;
    consumerName: string;
    batchSize: number;
    blockMs: number;
    claimIdleMs: number;
    maxDeliveries: number;
    /** Ceiling on the stream length for acknowledged messages (never drops an unacknowledged one). */
    maxStreamLength?: number;
    /** Acknowledged messages older than this many hours are trimmed from the audit stream. */
    streamMaxAgeHours: number;
    /** How often the audit-consumer trims the stream; 0 = never. */
    streamTrimIntervalMs: number;
  };
  consumer: {
    /** How often the consumer reclaims pending messages of crashed consumers. */
    reclaimIntervalMs: number;
    /** TTL of the per-workspace write lease (LEASE_STORE). */
    leaseTtlMs: number;
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
  /** Read API (apps/audit-api). */
  api: {
    /** The one workspace this deployment serves; injected into every request from the authenticated session. */
    workspaceId: string;
    adapters: { tokenVerifier: string; rateLimiter: string; scopeSource: string };
    firebaseProjectId: string;
    staticTokens: StaticTokenEntry[];
    access: { allowedEmails: string[]; allowedEmailDomains: string[]; adminEmails: string[] };
    corsOrigins: string[];
    trustProxy: boolean;
    rateLimit: { max: number; windowMs: number; chainMax: number; authFailureMax: number; authFailureWindowMs: number };
    analyticsAccounts: { platform: MetricPlatform; accountId: string }[];
    scopeCacheMs: number;
    chain: { maxRangeHours: number; maxEvents: number };
  };
  clickhouse: {
    url: string;
    username: string;
    password: string;
    database: string;
    migrationsDir: string;
    /** Credentials per role; each equals username/password above when the role has no user of its own. */
    roles: Record<ClickHouseRole, ClickHouseCredentials>;
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
  let staticTokens: StaticTokenEntry[] = [];
  if (e.AUDIT_API_STATIC_TOKENS !== '') {
    try {
      staticTokens = staticTokensSchema.parse(JSON.parse(e.AUDIT_API_STATIC_TOKENS));
    } catch (err) {
      issues.push(`AUDIT_API_STATIC_TOKENS: not a JSON array of { token, subject, email } (${(err as Error).message.slice(0, 120)})`);
    }
  }
  let analyticsAccounts: { platform: MetricPlatform; accountId: string }[] = [];
  try {
    analyticsAccounts = parseAccountRefs(e.AUDIT_API_ANALYTICS_ACCOUNTS);
  } catch (err) {
    issues.push(`AUDIT_API_ANALYTICS_ACCOUNTS: ${(err as Error).message}`);
  }
  let corsOrigins: string[] = [];
  try {
    corsOrigins = parseCorsOrigins(e.AUDIT_API_CORS_ORIGINS);
  } catch (err) {
    issues.push(`AUDIT_API_CORS_ORIGINS: ${(err as Error).message}`);
  }
  const isProduction = e.NODE_ENV === 'production';
  // Production: every role has its own user (default proba_consumer / proba_api / proba_migrator), never the shared admin user.
  // Development and test: a role without its own user falls back to CLICKHOUSE_USER so a single-user local stack keeps working.
  const roleCredentials = (
    role: ClickHouseRole,
    user: string | undefined,
    password: string | undefined
  ): ClickHouseCredentials => {
    const label = role.toUpperCase();
    if (user === undefined) {
      if (isProduction) return { username: DEFAULT_CLICKHOUSE_ROLE_USERS[role], password: password ?? '' };
      if (password !== undefined) issues.push(`CLICKHOUSE_${label}_PASSWORD: set without CLICKHOUSE_${label}_USER`);
      return { username: e.CLICKHOUSE_USER, password: e.CLICKHOUSE_PASSWORD };
    }
    // A role user without a password is not an error here: a service only needs the password of its OWN role (compose gives each service
    // just that one). The process that connects as the role refuses to start without it (ClickHouseRoleError), and the migrator
    // refuses to create the user without it (RoleProvisioningError).
    return { username: user, password: password ?? '' };
  };
  const clickhouseRoles: Record<ClickHouseRole, ClickHouseCredentials> = {
    consumer: roleCredentials('consumer', e.CLICKHOUSE_CONSUMER_USER, e.CLICKHOUSE_CONSUMER_PASSWORD),
    api: roleCredentials('api', e.CLICKHOUSE_API_USER, e.CLICKHOUSE_API_PASSWORD),
    migrator: roleCredentials('migrator', e.CLICKHOUSE_MIGRATOR_USER, e.CLICKHOUSE_MIGRATOR_PASSWORD),
  };
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
      auditContentStore: e.AUDIT_CONTENT_STORE,
      anchorStore: e.ANCHOR_STORE,
      leaseStore: e.LEASE_STORE,
    },
    anchors: { hmacKey: e.ANCHOR_HMAC_KEY, databaseUrl: e.ANCHOR_DATABASE_URL },
    allowInMemoryAdapters: e.ALLOW_IN_MEMORY_ADAPTERS,
    content: { enabled: e.AUDIT_CONTENT_ENABLED },
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
      streamMaxAgeHours: e.AUDIT_STREAM_MAX_AGE_HOURS,
      streamTrimIntervalMs: e.AUDIT_STREAM_TRIM_INTERVAL_MS,
    },
    consumer: {
      reclaimIntervalMs: e.CONSUMER_RECLAIM_INTERVAL_MS,
      retryBaseMs: e.CONSUMER_RETRY_BASE_MS,
      retryMaxMs: e.CONSUMER_RETRY_MAX_MS,
      selfAudit: e.SELF_AUDIT_ENABLED,
      selfAuditWorkspaceId: e.SELF_AUDIT_WORKSPACE_ID,
      leaseTtlMs: e.CONSUMER_LEASE_TTL_MS,
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
    api: {
      workspaceId: e.AUDIT_API_WORKSPACE_ID,
      adapters: { tokenVerifier: e.AUDIT_API_TOKEN_VERIFIER, rateLimiter: e.AUDIT_API_RATE_LIMITER, scopeSource: e.AUDIT_API_SCOPE_SOURCE },
      firebaseProjectId: e.FIREBASE_PROJECT_ID.trim(),
      staticTokens,
      access: {
        allowedEmails: parseList(e.AUDIT_API_ALLOWED_EMAILS),
        allowedEmailDomains: parseList(e.AUDIT_API_ALLOWED_EMAIL_DOMAINS),
        adminEmails: parseList(e.AUDIT_API_ADMIN_EMAILS),
      },
      corsOrigins,
      trustProxy: e.AUDIT_API_TRUST_PROXY,
      rateLimit: {
        max: e.AUDIT_API_RATE_LIMIT_MAX,
        windowMs: e.AUDIT_API_RATE_LIMIT_WINDOW_MS,
        chainMax: e.AUDIT_API_CHAIN_RATE_LIMIT_MAX,
        authFailureMax: e.AUDIT_API_AUTH_FAILURE_LIMIT_MAX,
        authFailureWindowMs: e.AUDIT_API_AUTH_FAILURE_WINDOW_MS,
      },
      analyticsAccounts,
      scopeCacheMs: e.AUDIT_API_SCOPE_CACHE_MS,
      chain: { maxRangeHours: e.AUDIT_API_CHAIN_MAX_RANGE_HOURS, maxEvents: e.AUDIT_API_CHAIN_MAX_EVENTS },
    },
    clickhouse: {
      url: e.CLICKHOUSE_URL,
      username: e.CLICKHOUSE_USER,
      password: e.CLICKHOUSE_PASSWORD,
      database: e.CLICKHOUSE_DATABASE,
      migrationsDir: e.CLICKHOUSE_MIGRATIONS_DIR,
      roles: clickhouseRoles,
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
    anchors: { hmacKey: config.anchors.hmacKey ? '[REDACTED]' : '', databaseUrl: config.anchors.databaseUrl ? redactUrl(config.anchors.databaseUrl) : '' },
    // Tokens are credentials: the log shows how many are configured, never the values.
    api: { ...config.api, staticTokens: config.api.staticTokens.map(() => '[REDACTED]') },
    eventBus: { ...config.eventBus, redisUrl: redactUrl(config.eventBus.redisUrl) },
    clickhouse: {
      ...config.clickhouse,
      url: redactUrl(config.clickhouse.url),
      password: config.clickhouse.password ? '[REDACTED]' : '',
      roles: Object.fromEntries(
        Object.entries(config.clickhouse.roles).map(([role, c]) => [role, { username: c.username, password: c.password ? '[REDACTED]' : '' }])
      ),
    },
  };
}

/** True when no email, domain or admin is configured for the read API: nobody can use it. */
export function isPolicyEmptyForConfig(config: AppConfig): boolean {
  const a = config.api.access;
  return a.allowedEmails.length === 0 && a.allowedEmailDomains.length === 0 && a.adminEmails.length === 0;
}
