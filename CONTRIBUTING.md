# Contributing to proba-audit

By contributing you agree that your contributions are licensed under the Apache License 2.0.

## Development setup

```bash
npm install
docker compose up -d clickhouse redis
npm run migrate
npm test                  # unit tests, in-memory adapters
npm run test:integration  # contract tests against the running ClickHouse and Redis
```

## Workflow

1. Create a feature branch: `git checkout -b feat/my-change`
2. Make your change, with tests (new adapters must run the contract suite for their port)
3. `npm run lint && npm run typecheck && npm test`
4. Commit with [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `docs:`, `test:`, `chore:`, ...)
5. Open a pull request against `main`

## Rules

- This repo is public: never commit secrets. Use `.env.example` for placeholders; real `.env` files are gitignored.
- `packages/core` has no adapter or I/O dependencies beyond config and logging: ports only.
- Edit no applied ClickHouse migration; add a new numbered one.
