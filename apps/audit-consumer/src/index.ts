import { runService } from '@smallseedlabs/proba-audit-core';

// Foundation only: loads config, logs lifecycle, serves /health, stops on SIGTERM.
// Business logic is added in later PRs.
runService({ name: 'audit-consumer', defaultPort: 3101 }).catch((err) => {
  console.error('fatal: audit-consumer failed to start', err);
  process.exit(1);
});
