import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const src = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    // Run tests against source so no build is needed first.
    alias: {
      '@smallseedlabs/proba-audit-core/testing': src('./packages/core/src/testing/index.ts'),
      '@smallseedlabs/proba-audit-core': src('./packages/core/src/index.ts'),
      '@smallseedlabs/proba-audit-adapters': src('./packages/adapters/src/index.ts'),
    },
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['packages/*/src/**/*.test.ts', 'apps/*/src/**/*.test.ts', 'scripts/**/*.test.ts'],
    exclude: ['**/*.integration.test.ts', '**/node_modules/**', '**/dist/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: ['**/*.test.ts', '**/*.integration.test.ts', '**/dist/**'],
    },
  },
});
