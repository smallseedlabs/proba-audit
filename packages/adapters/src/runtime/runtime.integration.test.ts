import { describe, expect, it } from 'vitest';
import { MemoryLogger, loadConfig } from '@smallseedlabs/proba-audit-core';
import { makeStoredAuditEvent } from '@smallseedlabs/proba-audit-core/testing';
import { createRuntime } from './registries.js';

describe('createRuntime with the default adapters (Redis Streams + ClickHouse)', () => {
  it('wires the real adapters from config and they reach their services', async () => {
    const config = loadConfig({
      ...process.env,
      EVENT_BUS: 'redis-streams',
      AUDIT_STORE: 'clickhouse',
      METRICS_STORE: 'clickhouse',
      CLICKHOUSE_DATABASE: process.env.CLICKHOUSE_TEST_DATABASE ?? 'proba_audit_test',
    });
    const rt = await createRuntime(config, { logger: new MemoryLogger() });
    try {
      await rt.eventBus.ping();
      await rt.auditStore.ping();
      await rt.metricsStore.ping();

      // Bus -> store round trip using the runtime's own ports.
      const topic = `rt-${rt.ids.uuid()}`;
      const sub = await rt.eventBus.subscribe({ topic, group: 'g', consumer: 'c' });
      const event = makeStoredAuditEvent({ workspaceId: `rt-${rt.ids.uuid()}` });
      await rt.eventBus.publish(topic, event);
      const [msg] = await sub.read<typeof event>({ blockMs: 1000 });
      expect(await rt.auditStore.appendBatch([msg.payload])).toEqual({ inserted: 1, duplicates: 0, conflicts: [] });
      await sub.ack([msg.id]);
      expect(await rt.auditStore.query({ workspaceId: event.workspaceId })).toEqual([event]);
      await sub.close();
    } finally {
      await rt.close();
    }
  });
});
