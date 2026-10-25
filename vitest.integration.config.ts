import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const src = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@smallseedlabs/proba-audit-core/testing': src('./packages/core/src/testing/index.ts'),
      '@smallseedlabs/proba-audit-core': src('./packages/core/src/index.ts'),
      '@smallseedlabs/proba-audit-adapters': src('./packages/adapters/src/index.ts'),
    },
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['packages/*/src/**/*.integration.test.ts', 'apps/*/src/**/*.integration.test.ts'],
    testTimeout: 30000,
    hookTimeout: 60000,
    fileParallelism: false, // Run test files sequentially: they share one Redis and one ClickHouse
  },
});
