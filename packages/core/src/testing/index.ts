/**
 * Contract-test helpers: run them against any adapter.
 * Imports vitest, so only import this entry point from test files.
 */

export * from './fixtures.js';
export * from './event-bus.contract.js';
export * from './audit-store.contract.js';
export * from './metrics-store.contract.js';
export * from './clock.contract.js';
export * from './id-generator.contract.js';
export * from './logger.contract.js';
export * from './platform-connector.contract.js';
export * from './outbox-store.contract.js';
