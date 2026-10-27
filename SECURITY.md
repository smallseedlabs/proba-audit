# Security policy

## Supported versions

proba-audit is pre-1.0 and has no long-lived release branches. Security fixes land on `main` and in the next release; only the latest release and `main` are supported.

## Reporting a vulnerability

Please do not open a public issue, pull request or discussion for a security problem.

Report it privately with GitHub private vulnerability reporting: open the repository's **Security** tab, choose **Report a vulnerability**,
and describe the problem. Include what is affected (component and version or commit), the steps to reproduce it, and the impact you expect.
Please do not include real credentials or personal data in the report.

You can expect an acknowledgement of the report, an assessment, and a fix or a mitigation plan. Once a fix is released the report may be
published as a security advisory, crediting the reporter if they wish.

## Handling secrets

This repository must never contain secrets: API keys, tokens, passwords or private keys. If you find one committed, report it as above so that it can be revoked and removed.

## Hardening notes for operators

- **Tamper evidence.** Every audit event is hash-chained per workspace, and the consumer records the signed head of each chain in a separate store (`ANCHOR_STORE`). `GET /v1/chain/verify` and `verifyChain` report
  edited events, removed events and deleted newest events (`tail_truncated`). Keep `ANCHOR_HMAC_KEY` (a secret of at least 32 characters, required in production) and the anchor database credentials out of the audit store's
  environment: whoever holds the key and can write the anchor store can forge anchors. Run the verification regularly (a maintenance job over the whole chain also compares the event count).
- **Append-only ClickHouse users, created by the migrator.** `npm run migrate` creates the `consumer` (INSERT + SELECT), `api` (SELECT only) and `migrator` (DDL, no access management) users from
  `CLICKHOUSE_CONSUMER_PASSWORD`, `CLICKHOUSE_API_PASSWORD` and `CLICKHOUSE_MIGRATOR_PASSWORD` (required in production) and grants them table by table; it is not opt-in. In production `audit-consumer` and `audit-api` refuse to start
  when their password is empty or when they would connect as the admin or migrator user, so a stolen consumer or api credential cannot `ALTER ... UPDATE/DELETE`, `DROP` or `TRUNCATE` the audit trail. Keep the admin
  (`CLICKHOUSE_USER`) credentials with the migration job only; rotate a role password by changing the variable and re-running `npm run migrate`.
- **Redis is authenticated.** The bundled Redis has no anonymous user (ACL user + password, no default) and denies `FLUSHALL`, `KEYS`, `CONFIG` and the other `@dangerous` commands to the audit user. With `NODE_ENV=production` a
  service whose `REDIS_URL` has no password refuses to start. Use `rediss://` (TLS, certificates verified) for a Redis outside a private network. The audit stream is trimmed only of messages every consumer group has
  acknowledged (older than `AUDIT_STREAM_MAX_AGE_HOURS`, default 72), so Redis memory stays bounded without ever dropping an unprocessed audit event; alert on consumer-group lag.
- **Local stack is loopback only, with no default passwords.** `docker-compose.yml` binds every published port to `127.0.0.1` and refuses to start until every password is set (`scripts/generate-local-env.sh` generates a `.env`).
  CI fails if a port loses the loopback bind or a password gains a default. To reach a service from another machine, put a TLS reverse proxy in front; do not widen the bind.
- **Tenant isolation.** Every metrics and trace query carries the workspace taken from the authenticated session, never from the request.
- **No volatile adapters in production.** In-memory adapters are refused when `NODE_ENV=production` unless `ALLOW_IN_MEMORY_ADAPTERS=true`; do not set it on a real deployment.
- **Replicas.** Run several `audit-consumer`, `metrics-ingester` or `rollup` replicas only with `LEASE_STORE=redis` (shared). The lease store fails closed: if Redis is unreachable the work waits instead of running twice.
- **Known limits.** An attacker who can both delete audit events and rewrite the anchor store with its key defeats the anchors. Deletions made before the first anchor of a workspace was written are not detectable. The lease store on a single
  Redis is not a consensus system; the work it protects is idempotent or re-verifiable.
