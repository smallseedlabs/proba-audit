# Protocol Pin Note (temporary)

proba-audit imports the audit and metric contract from
`@smallseedlabs/proba-protocol/audit` (`AuditEvent`, `StoredAuditEvent`,
`MetricObservation`, their zod schemas, `buildAuditEvent`, `generateSpanId`).

That contract is in an **open, unmerged pull request**:
https://github.com/smallseedlabs/proba-protocol/pull/4

Until it is merged and released, the dependency is pinned to an immutable commit
on that PR's branch (`feat/audit-and-metrics-schemas`):

```json
"@smallseedlabs/proba-protocol": "github:smallseedlabs/proba-protocol#4cfd9955c0010d8cc39e43d769c0b1ff8f3f64b5"
```

(in `packages/core/package.json` and `packages/adapters/package.json`).

## TODO

- [ ] When proba-protocol PR #4 is merged and the `v0.2.0` tag exists, change both
      dependencies to `github:smallseedlabs/proba-protocol#v0.2.0`, run `npm install`
      to refresh `package-lock.json`, and delete this file.
- Do not copy the schemas into this repo; the protocol package is the single source.
