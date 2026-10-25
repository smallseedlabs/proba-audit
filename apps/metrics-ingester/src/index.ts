import { runService } from '@smallseedlabs/proba-audit-core';

// Foundation only: loads config, logs lifecycle, serves /health, stops on SIGTERM.
// Business logic is added in later PRs.
runService({ name: 'metrics-ingester', defaultPort: 3102 }).catch((err) => {
  console.error('fatal: metrics-ingester failed to start', err);
  process.exit(1);
});
