import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig, parseIntervalOverrides, parsePlatformConnectors, redactConfig } from './index.js';

describe('loadConfig', () => {
  it('applies defaults', () => {
    const c = loadConfig({}, { serviceName: 'audit-api', defaultPort: 3100 });
    expect(c.env).toBe('development');
    expect(c.service).toEqual({ name: 'audit-api', host: '0.0.0.0', port: 3100 });
    expect(c.adapters).toEqual({
      eventBus: 'redis-streams',
      auditStore: 'clickhouse',
      metricsStore: 'clickhouse',
      checkpointStore: 'clickhouse',
      quarantineStore: 'clickhouse',
      auditContentStore: 'clickhouse',
    });
    expect(c.content.enabled).toBe(false);
    expect(c.connectors.pairs).toEqual([]);
    expect(c.connectors.allowStub).toBe(false);
    expect(c.ingest.intervalMs).toBe(60_000);
    expect(c.eventBus.auditTopic).toBe('proba.audit.events');
    expect(c.eventBus.maxDeliveries).toBe(5);
    expect(c.clickhouse.database).toBe('proba_audit');
    expect(c.log.level).toBe('info');
  });

  it('keeps raw text off unless AUDIT_CONTENT_ENABLED is set', () => {
    expect(loadConfig({}, { serviceName: 'audit-api' }).content.enabled).toBe(false);
    expect(loadConfig({ AUDIT_CONTENT_ENABLED: 'true' }, { serviceName: 'audit-api' }).content.enabled).toBe(true);
    expect(loadConfig({ AUDIT_CONTENT_ENABLED: 'false' }, { serviceName: 'audit-api' }).content.enabled).toBe(false);
    expect(loadConfig({ AUDIT_CONTENT_STORE: 'memory' }, { serviceName: 'audit-api' }).adapters.auditContentStore).toBe('memory');
  });

  it('reads and coerces values from the environment', () => {
    const c = loadConfig({
      NODE_ENV: 'production',
      PORT: '4000',
      LOG_LEVEL: 'debug',
      EVENT_BUS: 'memory',
      AUDIT_STORE: 'memory',
      BUS_BATCH_SIZE: '250',
      BUS_MAX_STREAM_LENGTH: '100000',
      SERVICE_NAME: 'custom',
      CONSUMER_NAME: 'c-1',
    });
    expect(c.isProduction).toBe(true);
    expect(c.service).toMatchObject({ name: 'custom', port: 4000 });
    expect(c.adapters.eventBus).toBe('memory');
    expect(c.eventBus).toMatchObject({ batchSize: 250, maxStreamLength: 100000, consumerName: 'c-1' });
  });

  it('has consumer defaults and reads overrides', () => {
    expect(loadConfig({}).consumer).toEqual({
      reclaimIntervalMs: 30000,
      retryBaseMs: 500,
      retryMaxMs: 30000,
      selfAudit: true,
      selfAuditWorkspaceId: 'seedbed',
    });
    expect(
      loadConfig({ SELF_AUDIT_ENABLED: 'false', CONSUMER_RETRY_MAX_MS: '1000', SELF_AUDIT_WORKSPACE_ID: 'ops' }).consumer
    ).toMatchObject({ selfAudit: false, retryMaxMs: 1000, selfAuditWorkspaceId: 'ops' });
    expect(() => loadConfig({ SELF_AUDIT_ENABLED: 'maybe' })).toThrow(/SELF_AUDIT_ENABLED/);
  });

  it('accepts adapter names that are not built in (new adapters need no schema change)', () => {
    expect(loadConfig({ EVENT_BUS: 'kafka' }).adapters.eventBus).toBe('kafka');
  });

  it('treats empty values as unset', () => {
    const c = loadConfig({ PORT: '', REDIS_URL: '', LOG_LEVEL: '' }, { defaultPort: 3200 });
    expect(c.service.port).toBe(3200);
    expect(c.eventBus.redisUrl).toBe('redis://localhost:6379');
  });

  it('fails fast with every problem listed', () => {
    try {
      loadConfig({ NODE_ENV: 'staging', PORT: 'abc', LOG_LEVEL: 'loud', BUS_BATCH_SIZE: '0', CLICKHOUSE_DATABASE: 'bad-name' });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      const issues = (err as ConfigError).issues.join('\n');
      for (const k of ['NODE_ENV', 'PORT', 'LOG_LEVEL', 'BUS_BATCH_SIZE', 'CLICKHOUSE_DATABASE']) expect(issues).toContain(k);
    }
  });

  it('redacts secrets for logging', () => {
    const c = loadConfig({
      CLICKHOUSE_PASSWORD: 'super-secret',
      REDIS_URL: 'redis://user:hunter2@redis:6379',
      CLICKHOUSE_URL: 'http://ch:secretpw@clickhouse:8123',
    });
    const text = JSON.stringify(redactConfig(c));
    expect(text).not.toContain('super-secret');
    expect(text).not.toContain('hunter2');
    expect(text).not.toContain('secretpw');
    expect(text).toContain('REDACTED');
  });
});

describe('metrics ingestion config', () => {
  it('parses PLATFORM_CONNECTORS into ordered platform:adapter pairs', () => {
    const c = loadConfig({ PLATFORM_CONNECTORS: 'meta:stub, google:stub ,reddit:reddit-lib', ALLOW_STUB_CONNECTOR: 'true' });
    expect(c.connectors.pairs).toEqual([
      { platform: 'meta', adapter: 'stub' },
      { platform: 'google', adapter: 'stub' },
      { platform: 'reddit', adapter: 'reddit-lib' },
    ]);
    expect(c.connectors.allowStub).toBe(true);
  });

  it('rejects malformed connector pairs and duplicates', () => {
    for (const bad of ['meta', 'meta:', ':stub', 'tiktok:stub', 'meta:a,meta:b']) {
      expect(() => parsePlatformConnectors(bad)).toThrow();
      expect(() => loadConfig({ PLATFORM_CONNECTORS: bad })).toThrow(ConfigError);
    }
    expect(parsePlatformConnectors('')).toEqual([]);
  });

  it('parses per-connector interval overrides', () => {
    expect(parseIntervalOverrides('meta:30000,google:120000')).toEqual({ meta: 30_000, google: 120_000 });
    expect(parseIntervalOverrides('')).toEqual({});
    for (const bad of ['meta', 'meta:abc', 'tiktok:1000', 'meta=10']) {
      expect(() => parseIntervalOverrides(bad)).toThrow();
    }
  });

  it('applies ingest overrides from the environment', () => {
    const c = loadConfig({ INGEST_INTERVAL_MS: '5000', INGEST_INTERVAL_OVERRIDES: 'x:1000', INGEST_WORKSPACE_ID: 'ws_1', STUB_SEED: 'abc' });
    expect(c.ingest.intervalMs).toBe(5000);
    expect(c.ingest.intervalOverridesMs).toEqual({ x: 1000 });
    expect(c.ingest.workspaceId).toBe('ws_1');
    expect(c.connectors.stub.seed).toBe('abc');
  });
});

describe('read API config', () => {
  it('has safe defaults: firebase verifier, no access, no cross-origin, one workspace', () => {
    const { api } = loadConfig({});
    expect(api.adapters).toEqual({ tokenVerifier: 'firebase', rateLimiter: 'memory', scopeSource: 'connectors' });
    expect(api.workspaceId).toBe('seedbed');
    expect(api.access).toEqual({ allowedEmails: [], allowedEmailDomains: [], adminEmails: [] });
    expect(api.corsOrigins).toEqual([]);
    expect(api.trustProxy).toBe(false);
    expect(api.staticTokens).toEqual([]);
    expect(api.chain).toEqual({ maxRangeHours: 24, maxEvents: 100000 });
    expect(api.rateLimit).toMatchObject({ max: 120, windowMs: 60000, chainMax: 6 });
  });

  it('reads lists case-insensitively and de-duplicated', () => {
    const { api } = loadConfig({
      AUDIT_API_ALLOWED_EMAILS: ' Ana@Example.com, bo@example.com ,ana@example.com',
      AUDIT_API_ALLOWED_EMAIL_DOMAINS: 'Example.COM',
      AUDIT_API_ADMIN_EMAILS: 'Root@Example.com',
      FIREBASE_PROJECT_ID: ' my-project ',
      AUDIT_API_WORKSPACE_ID: 'acme',
      AUDIT_API_TRUST_PROXY: 'true',
      AUDIT_API_TOKEN_VERIFIER: 'static',
      AUDIT_API_ANALYTICS_ACCOUNTS: 'meta:act_1, google:123-456',
    });
    expect(api.access).toEqual({ allowedEmails: ['ana@example.com', 'bo@example.com'], allowedEmailDomains: ['example.com'], adminEmails: ['root@example.com'] });
    expect(api).toMatchObject({ firebaseProjectId: 'my-project', workspaceId: 'acme', trustProxy: true });
    expect(api.analyticsAccounts).toEqual([{ platform: 'meta', accountId: 'act_1' }, { platform: 'google', accountId: '123-456' }]);
  });

  it('accepts only exact origins for CORS', () => {
    expect(loadConfig({ AUDIT_API_CORS_ORIGINS: 'http://localhost:5173, https://insights.example.com/' }).api.corsOrigins).toEqual(['http://localhost:5173', 'https://insights.example.com']);
    for (const bad of ['*', 'insights.example.com', 'https://insights.example.com/app', 'ftp://x.example.com']) {
      expect(() => loadConfig({ AUDIT_API_CORS_ORIGINS: bad }), bad).toThrow(/AUDIT_API_CORS_ORIGINS/);
    }
  });

  it('validates static tokens and analytics accounts', () => {
    const tokens = JSON.stringify([{ token: 'long-enough-token', subject: 's1', email: 'a@example.com' }]);
    expect(loadConfig({ AUDIT_API_STATIC_TOKENS: tokens }).api.staticTokens).toEqual([{ token: 'long-enough-token', subject: 's1', email: 'a@example.com', emailVerified: true }]);
    expect(() => loadConfig({ AUDIT_API_STATIC_TOKENS: 'not json' })).toThrow(/AUDIT_API_STATIC_TOKENS/);
    expect(() => loadConfig({ AUDIT_API_STATIC_TOKENS: JSON.stringify([{ token: 'short', subject: 's', email: 'a@example.com' }]) })).toThrow(/AUDIT_API_STATIC_TOKENS/);
    expect(() => loadConfig({ AUDIT_API_ANALYTICS_ACCOUNTS: 'nope:1' })).toThrow(/AUDIT_API_ANALYTICS_ACCOUNTS/);
    expect(() => loadConfig({ AUDIT_API_ANALYTICS_ACCOUNTS: 'meta' })).toThrow(/AUDIT_API_ANALYTICS_ACCOUNTS/);
  });

  it('never logs static tokens', () => {
    const tokens = JSON.stringify([{ token: 'long-enough-token', subject: 's1', email: 'a@example.com' }]);
    const logged = JSON.stringify(redactConfig(loadConfig({ AUDIT_API_STATIC_TOKENS: tokens })));
    expect(logged).not.toContain('long-enough-token');
  });
});
