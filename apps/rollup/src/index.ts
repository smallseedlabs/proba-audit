import { runService } from '@smallseedlabs/proba-audit-core';

// Foundation only: loads config, logs lifecycle, serves /health, stops on SIGTERM.
// Business logic is added in later PRs.
runService({ name: 'rollup', defaultPort: 3103 }).catch((err) => {
  console.error('fatal: rollup failed to start', err);
  process.exit(1);
});
