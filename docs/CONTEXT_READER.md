# The `context-reader` service role

The context bridge reads the audit trail on behalf of one user at a time, to build that user's context. It is not a person, so it does not use a
Firebase ID token. It is a service role with two credentials, a narrow allow-list of routes and reads that are limited to what the user did.
The contract of every call is in [`openapi.yaml`](openapi.yaml); a request and a response of each route, and the claims of both credentials,
are in [`contracts/context-reader/`](contracts/context-reader/).

## What a call carries

| Part | Value |
|------|-------|
| `Authorization: Bearer <service token>` | EdDSA JWT of the bridge: `iss` `proba-context`, `aud` `proba-audit`, `sub` `context-reader`, `jti`, `exp` at most 120 seconds after `iat`. Says **who is calling**. Verified with the keys in `CONTEXT_SERVICE_PUBLIC_KEY_FILE` (matched by the header's `kid`). |
| `X-Act-As: <assertion>` | EdDSA JWT of the Proba Hub: `iss` `proba-hub`, `aud` that lists `proba-audit`, the claims of the protocol's `ActAsAssertionClaims` (`sub` is the user, plus `workspaceId`, `goalId`, `threadId`, `scopes`, `jti`), `exp` at most 300 seconds after `iat`. Says **for whom**. Verified with the keys in `HUB_ASSERTION_PUBLIC_KEY_FILE`. |
| `?actorId=…&workspaceId=…` | Must equal the assertion's `sub` and `workspaceId`. |

A clock difference of up to 30 seconds is tolerated on both tokens. Any other signing algorithm, a missing `kid`, an unknown key, a wrong issuer or
audience, or a lifetime beyond the limits is refused.

| Case | Answer |
|------|--------|
| Service token missing or invalid | `401` |
| `X-Act-As` missing | `400` `act_as_required` |
| `actorId` or `workspaceId` missing | `400` `act_as_scope_required` |
| Assertion expired, for another audience or issuer, or badly signed | `403` `act_as_expired` / `act_as_invalid` |
| Parameters differ from the assertion | `403` `act_as_mismatch` |
| A route outside the allow-list | `403` `insufficient_role` |

Each refusal is recorded as `auth.denied` with the reason (never the tokens).

## Where it is accepted

Only these routes accept the role. Raw text (`/content` routes), chain verification, facets, the session route and everything administrative answer `403`.

- `GET /v1/events`, `GET /v1/events/{eventId}`
- `GET /v1/traces`, `GET /v1/traces/{traceId}`
- `GET /v1/analytics/summary`, `/compare`, `/campaigns`

## What it can read

- **Events**: only those whose actor is `actorId` in `workspaceId`. Never raw text, `contentDigest` or `hasContent`. Filters: `goalId`, `actionPrefix`
  (for example `goal.`), `since`, `limit` (default 25, at most 100; a larger value is a `400`), `cursor`. The look-back defaults to 7 days and is capped at 90 days. An event of somebody else is `404`, as if it did not exist.
- **Traces**: only those whose root event (the earliest span without a parent) belongs to the user. Other actors inside such a trace appear with pseudonymous ids. `limit` default 25, at most 50, look-back default 24 hours and at most 7 days. Another user's trace is `404`.
- **Analytics**: only the campaigns of goals the user owns in the workspace (and only the workspace's ad accounts). A user who owns no goal sees nothing.

The workspace is always applied in the store query, from the assertion, never defaulted.

### How a user is tied to campaigns

The metrics tables are keyed by ad account and campaign, with no user. The link comes from the audit trail itself, so no migration was needed: a goal
belongs to the user who recorded its `goal.created` event (as `actor.id` or `userId`), and the campaigns of that goal are the ones named by any event in
the workspace that carries both that `goalId` and a `campaignId`. At most 500 campaigns are considered per user. The ingester and the Hub therefore
need to keep writing `goalId` and `campaignId` on campaign events, and `userId` or the user as actor on `goal.created`.

## What is recorded

Every read is audited like any other read, by the same fail-closed emitter, with the actor `service:context-reader`, the user as `userId`, and in `details`
`caller` (`context-reader`), `assertionJti` and `tokenJti`; never the events, filters or figures. Single event reads are `audit.event_viewed`, single trace
reads `audit.trace_viewed`, analytics `analytics.queried` (and `analytics.compared` for `/compare`), lists `audit.searched`. If the audit event cannot be sent, the read fails.
Rate limiting is per user and workspace; rejected credentials count against the client address like any other failed sign-in.

## Turning it on

The role is off by default. Set:

| Variable | Meaning |
|----------|---------|
| `AUDIT_API_CONTEXT_READER_ENABLED` | `true` to accept the role. |
| `CONTEXT_SERVICE_PUBLIC_KEY_FILE` | Path of the JSON Web Key Set that holds the bridge's public key(s). |
| `HUB_ASSERTION_PUBLIC_KEY_FILE` | Path of the JSON Web Key Set that holds the Hub's public key(s). |

The service refuses to start when the role is enabled without both files, when a file is unreadable or holds anything but Ed25519 public keys (a file with private key material is refused), or when a key has no `kid`.
With `NODE_ENV=production` it also requires absolute paths, files that are not writable by group or others, two different files (the bridge and the Hub must not share a key), and refuses `AUDIT_API_TOKEN_VERIFIER=static`. Keys are read once at start-up; restart to rotate.

### Generating a key pair

Run once for the bridge and once for the Hub, each on the machine that will sign:

```bash
node scripts/generate-service-keypair.mjs --kid bridge-key-1 --out /secure/path/keys
node scripts/generate-service-keypair.mjs --kid hub-key-1 --out /secure/path/keys
```

Each run writes `<kid>.private.pem` (mode 0600; the signer keeps it) and `<kid>.jwks.json` (public). Give the audit-api host only the `.jwks.json` file and point the variable
at its absolute path. Private keys are ignored by git (`*.private.pem`) and must never be committed or copied to the audit-api host. To rotate, add the new key to the key set next
to the old one, switch the signer to the new `kid`, then remove the old key at the next restart.
