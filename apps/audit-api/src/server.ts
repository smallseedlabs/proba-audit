import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import {
  ACT_AS_HEADER,
  ANALYTICS_LIMITS,
  AuditedAnalyticsReader,
  AuditedReader,
  CONTEXT_READER_ROLE,
  MetricsAnalytics,
  TokenVerificationError,
  type AccessContext,
  type ContextBridgeAuth,
  type AppConfig,
  type AuditEmitter,
  type AnchorStore,
  type AuditContentStore,
  type AuditStore,
  type Clock,
  type Logger,
  type MetricsStore,
  type RateLimiter,
  type ScopeResolver,
  type TokenVerifier,
} from '@smallseedlabs/proba-audit-core';
import { CONTEXT_READER_ROUTES, authorize, sessionFromAssertion, type Role, type Session } from './authorization.js';
import { ApiError } from './http/errors.js';
import {
  actAsParamsSchema,
  campaignsQuerySchema,
  chainQuerySchema,
  compareQuerySchema,
  contextEventsQuerySchema,
  contextTracesQuerySchema,
  eventParamsSchema,
  eventsQuerySchema,
  facetsQuerySchema,
  noQuerySchema,
  parseWith,
  summaryQuerySchema,
  traceParamsSchema,
  tracesQuerySchema,
} from './http/schemas.js';
import { ReadService, type ReadMeta } from './read-service.js';

export const TRACE_HEADER = 'X-Trace-Id';

declare module 'fastify' {
  interface FastifyRequest {
    /** Id of this request: every log line and audit event of the request carries it. */
    traceId: string;
    /** Set by the authentication hook of /v1 routes. */
    session?: Session;
    startedAt: number;
  }
}

export interface ReadinessCheck {
  name: string;
  check: () => Promise<void>;
}

export interface ServerDeps {
  config: AppConfig;
  logger: Logger;
  clock: Clock;
  verifier: TokenVerifier;
  /** The credentials of the `context-reader` role. Absent: the role is off and its tokens are refused like any unknown token. */
  contextBridge?: ContextBridgeAuth;
  limiter: RateLimiter;
  auditStore: AuditStore;
  /** Raw text of events: served to administrators only, and only when config.content.enabled. */
  auditContentStore?: AuditContentStore;
  /** Signed chain heads (ANCHOR_STORE): chain verification reports `tail_truncated` against them. */
  anchorStore?: AnchorStore;
  metricsStore: MetricsStore;
  scope: ScopeResolver;
  /** Used for the reads themselves: if the audit event cannot be sent, the read is refused (fails closed). */
  emitter: AuditEmitter;
  /** Used for denials, errors and lifecycle events: a hiccup must not make things worse. */
  bestEffortEmitter: AuditEmitter;
  readiness: ReadinessCheck[];
}

const READINESS_TIMEOUT_MS = 2000;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** The path with every :param kept as a pattern, so logs and audit events never hold ids from the URL. */
const routeOf = (request: FastifyRequest): string => request.routeOptions?.url ?? 'unmatched';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Extra facts about who is denied: the `context-reader` role is a service acting for a user, not a person. */
interface DenyExtra {
  actor?: { type: 'service'; id: string };
  workspaceId?: string;
  verifier?: string;
  details?: Record<string, unknown>;
}

/**
 * Build the audit-api HTTP server. Every dependency is injected, so the same server runs on the real
 * adapters and, in tests, on in-memory ones. Mirrors proba-hub's server: Fastify, CORS, a trace id on
 * every response, one structured log line per request.
 */
export async function buildServer(deps: ServerDeps): Promise<FastifyInstance> {
  const { config, logger, clock } = deps;
  const api = config.api;

  const app = Fastify({
    logger: false,
    trustProxy: api.trustProxy,
    disableRequestLogging: true,
    // Bound everything a client controls.
    maxParamLength: 200,
  });

  // The accounts of the workspace; for the `context-reader` role also only the campaigns of the goals its user owns. Read from the
  // audit trail on every request (the link between a user and a campaign is the goal id both carry), never from a request parameter.
  const scopeFor: ScopeResolver = async (ctx) => {
    const base = await deps.scope(ctx);
    if (ctx.subjectActorId === undefined) return base;
    const campaignIds = await deps.auditStore.listOwnedCampaignIds({
      workspaceId: ctx.workspaceId,
      ownerId: ctx.subjectActorId,
      limit: ANALYTICS_LIMITS.maxCampaignsInScope,
    });
    return { ...base, campaignIds };
  };

  const reader = new AuditedReader(deps.auditStore, deps.emitter, clock);
  const analytics = new AuditedAnalyticsReader(
    new MetricsAnalytics(deps.metricsStore, { sourceGranularity: config.ingest.granularity }),
    scopeFor,
    deps.emitter,
    clock
  );
  const reads = new ReadService({
    auditStore: deps.auditStore,
    ...(deps.auditContentStore ? { contentStore: deps.auditContentStore } : {}),
    contentEnabled: config.content.enabled,
    ...(deps.anchorStore ? { anchorStore: deps.anchorStore } : {}),
    metricsStore: deps.metricsStore,
    reader,
    analytics,
    scope: scopeFor,
    clock,
    chain: api.chain,
  });

  app.decorateRequest('traceId', '');
  app.decorateRequest('session', undefined);
  app.decorateRequest('startedAt', 0);

  const log = (request: FastifyRequest): Logger => logger.child({ traceId: request.traceId });

  // First hook: this request's trace id, on the response from the start (also on errors and 404s).
  app.addHook('onRequest', async (request, reply) => {
    // Always a fresh id: a client-supplied one would let a caller write into somebody else's trace.
    request.traceId = randomUUID();
    request.startedAt = Date.now();
    reply.header(TRACE_HEADER, request.traceId);
    reply.header('Cache-Control', 'no-store');
    reply.header('X-Content-Type-Options', 'nosniff');
  });

  app.addHook('onResponse', async (request, reply) => {
    log(request).info('request completed', {
      method: request.method,
      route: routeOf(request),
      // Names only: parameter values can hold search text.
      queryParams: Object.keys((request.query as Record<string, unknown> | undefined) ?? {}).sort(),
      statusCode: reply.statusCode,
      durationMs: Date.now() - request.startedAt,
      ...(request.session ? { actor: request.session.subject, role: request.session.role, workspaceId: request.session.workspaceId } : {}),
      ...(request.session?.actAs ? { assertionJti: request.session.actAs.jti } : {}),
      remoteAddress: request.ip,
    });
  });

  await app.register(cors, {
    origin: api.corsOrigins.length > 0 ? api.corsOrigins : false,
    methods: ['GET', 'OPTIONS'],
    allowedHeaders: ['Authorization', 'Content-Type'],
    exposedHeaders: [TRACE_HEADER, 'Retry-After', 'X-RateLimit-Limit', 'X-RateLimit-Remaining'],
    credentials: false,
    maxAge: 600,
  });

  app.setNotFoundHandler(async (request, reply) => {
    reply.code(404).send({ error: 'not_found', message: 'This route does not exist.', traceId: request.traceId });
  });

  app.setErrorHandler(async (error, request, reply) => {
    if (error instanceof ApiError) {
      for (const [k, v] of Object.entries(error.headers ?? {})) reply.header(k, v);
      return reply.code(error.statusCode).send({
        error: error.code,
        message: error.message,
        ...(error.issues ? { issues: error.issues } : {}),
        traceId: request.traceId,
      });
    }
    const status = (error as { statusCode?: number }).statusCode ?? 500;
    const bodyError = (error as { error?: string }).error;
    if (status === 429 || bodyError === 'rate_limited') {
      const retryAfter = (error as { retryAfter?: string | number }).retryAfter;
      if (retryAfter !== undefined) reply.header('Retry-After', String(retryAfter));
      return reply.code(429).send({
        error: 'rate_limited',
        message: 'Too many requests. Try again shortly.',
        traceId: request.traceId,
      });
    }
    if (status < 500) {
      return reply.code(status).send({ error: 'bad_request', message: 'The request could not be understood.', traceId: request.traceId });
    }
    log(request).error('request failed', { err: error, route: routeOf(request) });
    await deps.bestEffortEmitter
      .forTrace(request.traceId)
      .emit({
        actor: { type: 'service', id: config.service.name },
        workspaceId: request.session?.workspaceId ?? api.workspaceId,
        action: 'system.error',
        category: 'system',
        outcome: 'failure',
        target: { type: 'route', id: `${request.method} ${routeOf(request)}` },
        errorCode: 'unhandled_error',
        errorMessage: error.message.slice(0, 500),
        riskLevel: 'medium',
        details: { component: 'http', statusCode: status },
      })
      .catch(() => null);
    return reply.code(500).send({ error: 'internal_error', message: 'Something went wrong. Try again in a moment.', traceId: request.traceId });
  });

  // -- Liveness and readiness: no authentication, no audit trail entry, nothing sensitive in the answer.
  app.get('/health', async () => ({ status: 'ok', service: config.service.name }));

  app.get('/ready', async (_request, reply) => {
    const results = await Promise.all(
      deps.readiness.map(async (r) => {
        try {
          await withTimeout(r.check(), READINESS_TIMEOUT_MS);
          return [r.name, 'ok'] as const;
        } catch {
          return [r.name, 'unavailable'] as const;
        }
      })
    );
    const ready = results.every(([, state]) => state === 'ok');
    return reply.code(ready ? 200 : 503).send({ status: ready ? 'ready' : 'not_ready', checks: Object.fromEntries(results) });
  });

  // -- Everything under /v1: authenticated, authorised, rate limited, read-only.
  await app.register(
    async (v1) => {
      // Framework rate limit so scanners (CodeQL MissingRateLimiting) see a recognised control on
      // authorised routes. Cap is intentionally high: deps.limiter remains the primary per-user /
      // per-bridge control and is what the API documents and tests.
      await v1.register(rateLimit, {
        global: true,
        max: Math.max(api.rateLimit.max * 100, 1_000),
        timeWindow: api.rateLimit.windowMs,
        errorResponseBuilder: (_request, context) => ({
          statusCode: 429,
          error: 'rate_limited',
          message: 'Too many requests. Try again shortly.',
          retryAfter: context.after,
        }),
      });

      const deny = async (
        request: FastifyRequest,
        reason: string,
        outcome: 'denied' | 'failure',
        actorId?: string,
        extra: DenyExtra = {}
      ): Promise<void> => {
        // A flood of rejected calls must not flood the audit trail: a few records per reason and client per minute.
        const gate = await deps.limiter.hit(`deny-audit:${reason}:${request.ip}`, 5, 60_000);
        if (!gate.allowed) return;
        await deps.bestEffortEmitter
          .forTrace(request.traceId)
          .emit({
            actor: extra.actor ?? (actorId ? { type: 'user', id: actorId } : { type: 'system', id: 'anonymous' }),
            workspaceId: extra.workspaceId ?? api.workspaceId,
            action: 'auth.denied',
            category: 'auth',
            outcome,
            errorCode: reason,
            riskLevel: 'medium',
            target: { type: 'route', id: `${request.method} ${routeOf(request)}` },
            details: { component: 'http', verifier: extra.verifier ?? deps.verifier.name, ...extra.details },
          })
          .catch(() => null);
      };

      const failAuth = async (
        request: FastifyRequest,
        reply: FastifyReply,
        status: number,
        code: string,
        message: string,
        outcome: 'denied' | 'failure',
        actorId?: string,
        extra?: DenyExtra
      ): Promise<FastifyReply> => {
        await deps.limiter.hit(`auth-fail:${request.ip}`, api.rateLimit.authFailureMax, api.rateLimit.authFailureWindowMs);
        log(request).info('request refused', { code, route: routeOf(request) });
        await deny(request, code, outcome, actorId, extra);
        if (status === 401) reply.header('WWW-Authenticate', 'Bearer realm="proba-audit"');
        return reply.code(status).send({ error: code, message, traceId: request.traceId });
      };

      /**
       * The `context-reader` role: a service token proves the bridge is calling, the Hub's act-as assertion proves for which user,
       * and the `actorId` / `workspaceId` of the request must say the same. The order is deliberate: the route is checked before
       * anything about the user, so the content, chain and admin routes answer 403 to this role whatever else is sent.
       */
      const admitBridgeCall = async (request: FastifyRequest, reply: FastifyReply, token: string, bridge: ContextBridgeAuth): Promise<FastifyReply | void> => {
        const caller = { type: 'service' as const, id: CONTEXT_READER_ROLE };
        const verifier = bridge.service.name;
        let service;
        try {
          service = await bridge.service.verify(token);
        } catch (err) {
          if (err instanceof TokenVerificationError) {
            const expired = err.code === 'token_expired';
            return failAuth(request, reply, 401, err.code, expired ? 'Your sign-in has expired. Sign in again.' : 'Your sign-in could not be verified. Sign in again.', 'failure', undefined, { verifier });
          }
          log(request).error('service token verification unavailable', { err });
          return reply.code(503).send({ error: 'auth_unavailable', message: 'Sign-in checks are unavailable right now. Try again in a moment.', traceId: request.traceId });
        }
        const refuse = async (status: number, code: string, message: string, extra: Record<string, unknown> = {}, workspaceId?: string): Promise<FastifyReply> => {
          log(request).info('request refused', { code, route: routeOf(request) });
          await deny(request, code, 'denied', undefined, { actor: caller, verifier, ...(workspaceId ? { workspaceId } : {}), details: { caller: CONTEXT_READER_ROLE, tokenJti: service.jti, ...extra } });
          return reply.code(status).send({ error: code, message, traceId: request.traceId });
        };

        if (!CONTEXT_READER_ROUTES.has(`${request.method} ${routeOf(request)}`)) {
          return refuse(403, 'insufficient_role', 'This role cannot use this route.');
        }
        const assertionHeader = request.headers[ACT_AS_HEADER];
        if (typeof assertionHeader !== 'string' || assertionHeader.trim() === '') {
          return refuse(400, 'act_as_required', 'The X-Act-As assertion is required.');
        }
        let assertion;
        try {
          assertion = await bridge.assertions.verify(assertionHeader.trim());
        } catch (err) {
          if (err instanceof TokenVerificationError) {
            return refuse(403, err.code === 'token_expired' ? 'act_as_expired' : 'act_as_invalid', 'The X-Act-As assertion is not valid.');
          }
          log(request).error('act-as verification unavailable', { err });
          return reply.code(503).send({ error: 'auth_unavailable', message: 'Sign-in checks are unavailable right now. Try again in a moment.', traceId: request.traceId });
        }
        const withAssertion = { assertionJti: assertion.jti };
        const params = actAsParamsSchema.safeParse(request.query);
        if (!params.success) {
          return refuse(400, 'act_as_scope_required', 'actorId and workspaceId are required query parameters.', withAssertion, assertion.workspaceId);
        }
        if (params.data.actorId !== assertion.sub || params.data.workspaceId !== assertion.workspaceId) {
          return refuse(403, 'act_as_mismatch', 'actorId and workspaceId must match the X-Act-As assertion.', withAssertion, assertion.workspaceId);
        }

        const session = sessionFromAssertion(assertion, service.jti);
        request.session = session;
        // Per user and workspace, so one busy user cannot use up the bridge's allowance for everybody else.
        const rate = await deps.limiter.hit(`context-reader:${assertion.workspaceId}:${assertion.sub}`, api.rateLimit.max, api.rateLimit.windowMs);
        reply.header('X-RateLimit-Limit', String(rate.limit)).header('X-RateLimit-Remaining', String(rate.remaining));
        if (!rate.allowed) {
          await deny(request, 'rate_limited', 'denied', undefined, { actor: caller, verifier, workspaceId: assertion.workspaceId, details: { caller: CONTEXT_READER_ROLE, tokenJti: service.jti, ...withAssertion } });
          return reply
            .code(429)
            .header('Retry-After', String(rate.retryAfterSeconds))
            .send({ error: 'rate_limited', message: 'Too many requests. Try again shortly.', traceId: request.traceId });
        }
      };

      v1.addHook('preHandler', async (request, reply) => {
        // 1. A client that keeps presenting bad credentials is refused before any token work.
        const failures = await deps.limiter.peek(`auth-fail:${request.ip}`, api.rateLimit.authFailureMax, api.rateLimit.authFailureWindowMs);
        if (!failures.allowed) {
          await deny(request, 'rate_limited', 'denied');
          return reply
            .code(429)
            .header('Retry-After', String(failures.retryAfterSeconds))
            .send({ error: 'rate_limited', message: 'Too many rejected sign-ins. Try again later.', traceId: request.traceId });
        }

        // 2. Who is calling. Only the Authorization header carries a token: never the URL.
        const header = request.headers.authorization;
        if (!header || !/^Bearer\s+\S+$/i.test(header)) {
          return failAuth(request, reply, 401, 'missing_token', 'Sign in to continue.', 'failure');
        }
        const presented = header.replace(/^Bearer\s+/i, '');
        if (deps.contextBridge?.service.claimsToBeBridge(presented)) return admitBridgeCall(request, reply, presented, deps.contextBridge);
        let identity;
        try {
          identity = await deps.verifier.verify(presented);
        } catch (err) {
          if (err instanceof TokenVerificationError) {
            const expired = err.code === 'token_expired';
            return failAuth(
              request,
              reply,
              401,
              err.code,
              expired ? 'Your sign-in has expired. Sign in again.' : 'Your sign-in could not be verified. Sign in again.',
              'failure'
            );
          }
          log(request).error('token verification unavailable', { err });
          return reply.code(503).send({ error: 'auth_unavailable', message: 'Sign-in checks are unavailable right now. Try again in a moment.', traceId: request.traceId });
        }

        // 3. May they use the API, and as what. The workspace is set here, from configuration.
        const decision = authorize(identity, api.access, api.workspaceId);
        if (!decision.ok) {
          return failAuth(request, reply, 403, decision.reason, 'This account does not have access to audit data.', 'denied', identity.subject);
        }
        request.session = decision.session;

        // 4. Per-caller rate limit.
        const rate = await deps.limiter.hit(`user:${decision.session.subject}`, api.rateLimit.max, api.rateLimit.windowMs);
        reply.header('X-RateLimit-Limit', String(rate.limit)).header('X-RateLimit-Remaining', String(rate.remaining));
        if (!rate.allowed) {
          await deny(request, 'rate_limited', 'denied', decision.session.subject);
          return reply
            .code(429)
            .header('Retry-After', String(rate.retryAfterSeconds))
            .send({ error: 'rate_limited', message: 'Too many requests. Try again shortly.', traceId: request.traceId });
        }
      });

      const need = (request: FastifyRequest): Session => {
        if (!request.session) throw new ApiError(401, 'missing_token', 'Sign in to continue.');
        return request.session;
      };
      const requireRole = async (request: FastifyRequest, role: Role): Promise<Session> => {
        const session = need(request);
        if (role === 'admin' && session.role !== 'admin') {
          await deny(request, 'insufficient_role', 'denied', session.subject);
          throw new ApiError(403, 'insufficient_role', 'This needs an administrator account.');
        }
        return session;
      };
      const contextOf = (request: FastifyRequest, session: Session): AccessContext => {
        if (!session.actAs) return { actor: { type: 'user', id: session.subject }, workspaceId: session.workspaceId, traceId: request.traceId };
        // The reader is the bridge (a service), acting for the user of the assertion; its reads are recorded under the bridge, with
        // the ids of the assertion and the token, never under the user.
        return {
          actor: { type: 'service', id: CONTEXT_READER_ROLE },
          workspaceId: session.workspaceId,
          ...(UUID.test(session.actAs.actorId) ? { userId: session.actAs.actorId } : {}),
          traceId: request.traceId,
          subjectActorId: session.actAs.actorId,
          auditDetails: { caller: CONTEXT_READER_ROLE, assertionJti: session.actAs.jti, ...(session.tokenJti ? { tokenJti: session.tokenJti } : {}) },
        };
      };
      /** The query as the route's schema sees it: the `context-reader` role's `actorId` and `workspaceId` were already checked against the assertion. */
      const queryOf = (request: FastifyRequest, session: Session): unknown => {
        if (!session.actAs) return request.query;
        const { actorId: _actorId, workspaceId: _workspaceId, ...rest } = (request.query ?? {}) as Record<string, unknown>;
        return rest;
      };
      const metaOf = (request: FastifyRequest, session: Session): ReadMeta => ({ route: `${request.method} ${routeOf(request)}`, role: session.role });

      v1.get('/session', async (request) => {
        parseWith(noQuerySchema, request.query);
        const session = need(request);
        // The caller's own identity and role, taken from the token: nothing is read from the audit trail or
        // the metrics, so there is no data-access event for it (the catalog has no action for it either).
        return {
          subject: session.subject,
          email: session.email,
          role: session.role,
          workspaceId: session.workspaceId,
        };
      });

      v1.get('/events', async (request) => {
        const session = need(request);
        if (session.actAs) {
          return reads.searchEventsForSubject(contextOf(request, session), parseWith(contextEventsQuerySchema, queryOf(request, session)), metaOf(request, session));
        }
        return reads.searchEvents(contextOf(request, session), parseWith(eventsQuerySchema, request.query), metaOf(request, session));
      });

      v1.get('/events/:eventId', async (request) => {
        const session = need(request);
        parseWith(noQuerySchema, queryOf(request, session));
        const { eventId } = parseWith(eventParamsSchema, request.params, 'path');
        if (session.actAs) return reads.getEventForSubject(contextOf(request, session), eventId, metaOf(request, session));
        return reads.getEvent(contextOf(request, session), eventId, metaOf(request, session));
      });

      v1.get('/events/:eventId/content', async (request) => {
        // Raw text: administrators only. A viewer is refused (and the refusal is audited) before anything is read.
        const session = await requireRole(request, 'admin');
        parseWith(noQuerySchema, request.query);
        const { eventId } = parseWith(eventParamsSchema, request.params, 'path');
        return reads.getEventContent(contextOf(request, session), eventId, metaOf(request, session));
      });

      v1.get('/traces', async (request) => {
        const session = need(request);
        if (session.actAs) {
          return reads.listTracesForSubject(contextOf(request, session), parseWith(contextTracesQuerySchema, queryOf(request, session)), metaOf(request, session));
        }
        return reads.listTraces(contextOf(request, session), parseWith(tracesQuerySchema, request.query), metaOf(request, session));
      });

      v1.get('/traces/:traceId', async (request) => {
        const session = need(request);
        parseWith(noQuerySchema, queryOf(request, session));
        const { traceId } = parseWith(traceParamsSchema, request.params, 'path');
        if (session.actAs) return reads.getTraceForSubject(contextOf(request, session), traceId, metaOf(request, session));
        return reads.getTrace(contextOf(request, session), traceId, metaOf(request, session));
      });

      v1.get('/traces/:traceId/content', async (request) => {
        const session = await requireRole(request, 'admin');
        parseWith(noQuerySchema, request.query);
        const { traceId } = parseWith(traceParamsSchema, request.params, 'path');
        return reads.getTraceContent(contextOf(request, session), traceId, metaOf(request, session));
      });

      v1.get('/chain/verify', async (request, reply) => {
        const session = await requireRole(request, 'admin');
        const query = parseWith(chainQuerySchema, request.query);
        // Verification reads a lot of rows: its own, tighter limit on top of the general one.
        const rate = await deps.limiter.hit(`chain:${session.subject}`, api.rateLimit.chainMax, api.rateLimit.windowMs);
        if (!rate.allowed) {
          await deny(request, 'rate_limited', 'denied', session.subject);
          return reply
            .code(429)
            .header('Retry-After', String(rate.retryAfterSeconds))
            .send({ error: 'rate_limited', message: 'Chain verification is limited. Try again shortly.', traceId: request.traceId });
        }
        return reads.verifyChain(contextOf(request, session), query, metaOf(request, session));
      });

      v1.get('/analytics/summary', async (request) => {
        const session = need(request);
        return reads.summary(contextOf(request, session), parseWith(summaryQuerySchema, queryOf(request, session)));
      });

      v1.get('/analytics/compare', async (request) => {
        const session = need(request);
        return reads.compare(contextOf(request, session), parseWith(compareQuerySchema, queryOf(request, session)));
      });

      v1.get('/analytics/campaigns', async (request) => {
        const session = need(request);
        return reads.campaigns(contextOf(request, session), parseWith(campaignsQuerySchema, queryOf(request, session)));
      });

      v1.get('/facets', async (request) => {
        const session = need(request);
        return reads.facets(contextOf(request, session), parseWith(facetsQuerySchema, request.query), metaOf(request, session));
      });
    },
    { prefix: '/v1' }
  );

  return app;
}
