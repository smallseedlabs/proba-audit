/* eslint-disable @typescript-eslint/no-explicit-any -- response bodies are inspected loosely in tests */
/**
 * Test harness: the real audit-api server on in-memory adapters (store, metrics, bus, rate limiter) and
 * the static token verifier, plus helpers to seed data and to read the audit events the API emitted.
 */
import {
  MemoryLogger,
  buildAuditEvent,
  chainEvent,
  createBusAuditEmitter,
  loadConfig,
  type AppConfig,
  type AuditEmitter,
  type AuditContent,
  type AuditEvent,
  type ChainLink,
  type MetricObservation,
  type RateLimiter,
  type StoredAuditEvent,
  type Subscription,
} from '@smallseedlabs/proba-audit-core';
import {
  InMemoryAnchorStore,
  InMemoryAuditContentStore,
  InMemoryAuditStore,
  InMemoryEventBus,
  InMemoryMetricsStore,
  InMemoryRateLimiter,
  ManualClock,
  SequentialIdGenerator,
  StaticTokenVerifier,
  createContextBridgeAuth,
  createContextBridgeSigners,
  type AssertionOptions,
  type ContextBridgeSigners,
  type ServiceTokenOptions,
} from '@smallseedlabs/proba-audit-adapters';
import { randomUUID } from 'node:crypto';
import type { OutgoingHttpHeaders } from 'node:http';
import type { FastifyInstance } from 'fastify';
import { buildServer, type ReadinessCheck } from './server.js';
import { createStaticScope } from './scope.js';

export const TOPIC = 'proba.audit.events';
export const WORKSPACE = 'seedbed';
export const FOREIGN_WORKSPACE = 'other-workspace';

export const TOKENS = {
  viewer: 'viewer-token-0001',
  admin: 'admin-token-0002',
  domain: 'domain-token-0003',
  outsider: 'outsider-token-0004',
  unverified: 'unverified-token-0005',
} as const;

const IDENTITIES = [
  { token: TOKENS.viewer, subject: 'uid-viewer', email: 'Viewer@insights.example' },
  { token: TOKENS.admin, subject: 'uid-admin', email: 'admin@insights.example' },
  { token: TOKENS.domain, subject: 'uid-domain', email: 'someone@partner.example' },
  { token: TOKENS.outsider, subject: 'uid-outsider', email: 'stranger@elsewhere.example' },
  { token: TOKENS.unverified, subject: 'uid-unverified', email: 'viewer@insights.example', emailVerified: false },
];

export function testConfig(overrides: Record<string, string> = {}): AppConfig {
  return loadConfig(
    {
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      AUDIT_API_TOKEN_VERIFIER: 'static',
      AUDIT_API_STATIC_TOKENS: JSON.stringify(IDENTITIES),
      AUDIT_API_ALLOWED_EMAILS: 'viewer@insights.example',
      AUDIT_API_ALLOWED_EMAIL_DOMAINS: 'partner.example',
      AUDIT_API_ADMIN_EMAILS: 'admin@insights.example',
      AUDIT_API_CORS_ORIGINS: 'http://localhost:5173',
      AUDIT_API_WORKSPACE_ID: WORKSPACE,
      AUDIT_API_SCOPE_SOURCE: 'static',
      AUDIT_API_ANALYTICS_ACCOUNTS: 'meta:act_1',
      ...overrides,
    },
    { serviceName: 'audit-api' }
  );
}

export interface HarnessOptions {
  env?: Record<string, string>;
  /** Turn the `context-reader` role on, with its two key files written to a temporary directory. */
  contextReader?: boolean;
  limiter?: RateLimiter;
  readiness?: ReadinessCheck[];
  /** Replace the emitter used for reads (to make auditing fail). */
  emitter?: (bus: InMemoryEventBus, base: AuditEmitter) => AuditEmitter;
}

export interface Harness {
  app: FastifyInstance;
  config: AppConfig;
  store: InMemoryAuditStore;
  contentStore: InMemoryAuditContentStore;
  anchors: InMemoryAnchorStore;
  metrics: InMemoryMetricsStore;
  bus: InMemoryEventBus;
  logger: MemoryLogger;
  clock: ManualClock;
  get(path: string, token?: string | null, headers?: Record<string, string>): Promise<{ status: number; body: any; headers: OutgoingHttpHeaders }>;
  /** The signers of the bridge's service token and the Hub's assertion (present when `contextReader` is on). */
  signers: ContextBridgeSigners;
  /**
   * A call as the `context-reader` role: a valid service token and a valid assertion for `actorId` in `workspaceId` unless
   * overridden, with `actorId` and `workspaceId` appended to the query unless `query` is false.
   */
  asContextReader(
    path: string,
    options?: {
      actorId?: string;
      workspaceId?: string;
      assertion?: AssertionOptions | string | null;
      service?: ServiceTokenOptions | string | null;
      /** The actorId / workspaceId query parameters sent: default the acting user's. `false` sends none. */
      query?: { actorId?: string | null; workspaceId?: string | null } | false;
    }
  ): Promise<{ status: number; body: any; headers: OutgoingHttpHeaders }>;
  /** Everything the API published on the audit topic so far. */
  emitted(): Promise<AuditEvent[]>;
  close(): Promise<void>;
}

export async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
  const clock = new ManualClock('2026-10-25T12:00:00.000Z');
  const signers = await createContextBridgeSigners(() => clock.now());
  const keyEnv: Record<string, string> = options.contextReader
    ? {
        AUDIT_API_CONTEXT_READER_ENABLED: 'true',
        CONTEXT_SERVICE_PUBLIC_KEY_FILE: await signers.service.writeJwks(),
        HUB_ASSERTION_PUBLIC_KEY_FILE: await signers.hub.writeJwks(),
      }
    : {};
  const config = testConfig({ ...keyEnv, ...options.env });
  const contextBridge = await createContextBridgeAuth(config, { now: () => clock.now() });
  const ids = new SequentialIdGenerator();
  const logger = new MemoryLogger();
  const store = new InMemoryAuditStore();
  const contentStore = new InMemoryAuditContentStore();
  const anchors = new InMemoryAnchorStore({ hmacKey: 'api-harness-anchor-key-0123456789-0123456789' });
  const metrics = new InMemoryMetricsStore(clock);
  const bus = new InMemoryEventBus(clock);
  const limiter = options.limiter ?? new InMemoryRateLimiter(clock);
  const emitterDeps = { bus, topic: TOPIC, service: 'audit-api', defaultWorkspaceId: WORKSPACE, clock, ids, logger };
  const strict = createBusAuditEmitter({ ...emitterDeps, failureMode: 'throw' });
  const app = await buildServer({
    config,
    logger,
    clock,
    verifier: new StaticTokenVerifier({ tokens: config.api.staticTokens, nodeEnv: config.env }),
    ...(contextBridge ? { contextBridge } : {}),
    limiter,
    auditStore: store,
    auditContentStore: contentStore,
    anchorStore: anchors,
    metricsStore: metrics,
    scope: createStaticScope(WORKSPACE, config.api.analyticsAccounts).resolve,
    emitter: options.emitter ? options.emitter(bus, strict) : strict,
    bestEffortEmitter: createBusAuditEmitter({ ...emitterDeps, failureMode: 'swallow' }),
    readiness: options.readiness ?? [{ name: 'auditStore', check: () => store.ping() }],
  });

  let reader: Subscription | undefined;
  const request = async (path: string, token: string | null, headers: Record<string, string>) => {
    const res = await app.inject({
      method: 'GET',
      url: path,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    });
    let body: unknown;
    try {
      body = res.json();
    } catch {
      body = res.body;
    }
    return { status: res.statusCode, body, headers: res.headers };
  };
  return {
    app,
    config,
    store,
    contentStore,
    anchors,
    metrics,
    bus,
    logger,
    clock,
    signers,
    async get(path, token = TOKENS.viewer, headers = {}) {
      return request(path, token, headers);
    },
    async asContextReader(path, o = {}) {
      const actorId = o.actorId ?? randomUUID();
      const workspaceId = o.workspaceId ?? WORKSPACE;
      const token = typeof o.service === 'string' ? o.service : o.service === null ? null : await signers.mintServiceToken(o.service);
      const assertion =
        typeof o.assertion === 'string' ? o.assertion : o.assertion === null ? null : await signers.mintAssertion({ sub: actorId, workspaceId, ...o.assertion });
      const params = new URLSearchParams();
      if (o.query !== false) {
        const actor = o.query?.actorId === undefined ? actorId : o.query.actorId;
        const workspace = o.query?.workspaceId === undefined ? workspaceId : o.query.workspaceId;
        if (actor !== null) params.set('actorId', actor);
        if (workspace !== null) params.set('workspaceId', workspace);
      }
      const joined = params.size > 0 ? `${path}${path.includes('?') ? '&' : '?'}${params.toString()}` : path;
      return request(joined, token, assertion ? { 'x-act-as': assertion } : {});
    },
    async emitted() {
      reader ??= await bus.subscribe({ topic: TOPIC, group: 'test-reader', consumer: 'c1' });
      const messages = await reader.read<AuditEvent>({ max: 1000 });
      await reader.ack(messages.map((m) => m.id));
      return messages.map((m) => m.payload);
    },
    async close() {
      await app.close();
      await limiter.close();
    },
  };
}

let seq = 0;

/** A valid event (not yet chained). */
export function makeEvent(overrides: Partial<AuditEvent> = {}): AuditEvent {
  seq += 1;
  return buildAuditEvent({
    eventId: `00000000-0000-4000-8000-${seq.toString(16).padStart(12, '0')}`,
    traceId: `10000000-0000-4000-8000-${seq.toString(16).padStart(12, '0')}`,
    workspaceId: WORKSPACE,
    actor: { type: 'service', id: 'hub' },
    service: 'hub',
    action: 'command.received',
    category: 'command',
    outcome: 'success',
    occurredAt: '2026-10-25T10:00:00.000Z',
    details: {},
    ...overrides,
  });
}

/** Chain `events` per workspace in the given order, as the audit consumer would (ingested one second apart from `ingestStart`). */
export function chainAll(events: AuditEvent[], ingestStart = '2026-10-25T10:00:00.000Z'): StoredAuditEvent[] {
  const heads = new Map<string, ChainLink | null>();
  let t = Date.parse(ingestStart);
  return events.map((e) => {
    const stored = chainEvent(e, heads.get(e.workspaceId) ?? null, new Date(t).toISOString());
    t += 1000;
    heads.set(e.workspaceId, { hash: stored.hash, ingestedAt: stored.ingestedAt });
    return stored;
  });
}

export function makeObservation(overrides: Partial<MetricObservation> = {}): MetricObservation {
  return {
    version: 1,
    platform: 'meta',
    accountId: 'act_1',
    campaignId: 'cmp_1',
    granularity: 'hour',
    periodStart: '2026-10-25T10:00:00.000Z',
    periodEnd: '2026-10-25T11:00:00.000Z',
    metrics: { impressions: 1000, clicks: 50, spend: 12.5, conversions: 2 },
    currency: 'USD',
    fetchedAt: '2026-10-25T11:05:00.000Z',
    revision: 0,
    ...overrides,
  };
}

/**
 * Seed events that carry raw text the way the consumer stores them: the event row gets `contentDigest` (covered by
 * its hash), the text goes to the content store. Returns the stored events in order.
 */
export async function seedWithContent(
  h: Harness,
  items: { event?: Partial<AuditEvent>; content: AuditContent }[]
): Promise<StoredAuditEvent[]> {
  const events = items.map((i) => makeEvent({ ...i.event, content: i.content }));
  const chained = chainAll(events);
  await h.store.appendBatch(chained);
  await h.contentStore.put(
    chained.flatMap((c, i) =>
      c.contentDigest
        ? [{ workspaceId: c.workspaceId, eventId: c.eventId, occurredAt: c.occurredAt, content: items[i].content, contentDigest: c.contentDigest }]
        : []
    )
  );
  return chained;
}
