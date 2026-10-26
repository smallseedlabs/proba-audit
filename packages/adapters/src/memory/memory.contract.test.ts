import {
  runAuditStoreContract,
  runAuditContentStoreContract,
  runClockContract,
  runEventBusContract,
  runIdGeneratorContract,
  runMetricsStoreContract,
  runCheckpointStoreContract,
  runQuarantineStoreContract,
  runOutboxStoreContract,
  runPlatformConnectorContract,
  makeObservation,
} from '@smallseedlabs/proba-audit-core/testing';
import { InMemoryAuditStore } from './audit-store.js';
import { InMemoryAuditContentStore } from './audit-content-store.js';
import { ManualClock, SequentialIdGenerator } from './clock-ids.js';
import { InMemoryCheckpointStore } from './checkpoint-store.js';
import { InMemoryQuarantineStore } from './quarantine-store.js';
import { InMemoryEventBus } from './event-bus.js';
import { InMemoryMetricsStore } from './metrics-store.js';
import { InMemoryOutboxStore } from './outbox-store.js';
import { StaticPlatformConnector } from './platform-connector.js';
import { RandomIdGenerator, SystemClock } from '../runtime/system.js';

runEventBusContract('memory', async () => ({ bus: new InMemoryEventBus() }));
runAuditStoreContract('memory', async () => ({ store: new InMemoryAuditStore() }));
runAuditContentStoreContract('memory', async () => ({ store: new InMemoryAuditContentStore() }));
runOutboxStoreContract('memory', async () => ({ store: new InMemoryOutboxStore() }));
runMetricsStoreContract('memory', async () => ({ store: new InMemoryMetricsStore() }));
runCheckpointStoreContract('memory', async () => ({ store: new InMemoryCheckpointStore() }));
runQuarantineStoreContract('memory', async () => ({ store: new InMemoryQuarantineStore() }));
runClockContract('SystemClock', () => new SystemClock());
runClockContract('ManualClock', () => new ManualClock(new Date()));
runIdGeneratorContract('RandomIdGenerator', () => new RandomIdGenerator());
runIdGeneratorContract('SequentialIdGenerator', () => new SequentialIdGenerator());

// 30 hourly rows for act_1 inside the contract's 24h window, plus rows of another account.
const NOW = new Date('2026-10-25T12:00:00.000Z');
const hourStart = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();
const observations = [
  ...Array.from({ length: 24 }, (_, i) =>
    ['cmp_1', 'cmp_2'].map((campaignId) =>
      makeObservation({ platform: 'meta', accountId: 'act_1', campaignId, periodStart: hourStart(i + 1), periodEnd: hourStart(i), timezone: 'Europe/London' })
    )
  ).flat(),
  makeObservation({ platform: 'meta', accountId: 'act_2' }),
];
runPlatformConnectorContract('StaticPlatformConnector', () => new StaticPlatformConnector('meta', observations), {
  now: () => NOW,
});
