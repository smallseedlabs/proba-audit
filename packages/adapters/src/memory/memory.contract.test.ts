import {
  runAuditStoreContract,
  runClockContract,
  runEventBusContract,
  runIdGeneratorContract,
  runMetricsStoreContract,
  runPlatformConnectorContract,
  makeObservation,
} from '@smallseedlabs/proba-audit-core/testing';
import { InMemoryAuditStore } from './audit-store.js';
import { ManualClock, SequentialIdGenerator } from './clock-ids.js';
import { InMemoryEventBus } from './event-bus.js';
import { InMemoryMetricsStore } from './metrics-store.js';
import { StaticPlatformConnector } from './platform-connector.js';
import { RandomIdGenerator, SystemClock } from '../runtime/system.js';

runEventBusContract('memory', async () => ({ bus: new InMemoryEventBus() }));
runAuditStoreContract('memory', async () => ({ store: new InMemoryAuditStore() }));
runMetricsStoreContract('memory', async () => ({ store: new InMemoryMetricsStore() }));
runClockContract('SystemClock', () => new SystemClock());
runClockContract('ManualClock', () => new ManualClock(new Date()));
runIdGeneratorContract('RandomIdGenerator', () => new RandomIdGenerator());
runIdGeneratorContract('SequentialIdGenerator', () => new SequentialIdGenerator());

const observations = [
  makeObservation({ platform: 'meta', accountId: 'act_1', periodStart: '2026-10-25T10:00:00.000Z', periodEnd: '2026-10-25T11:00:00.000Z' }),
  makeObservation({ platform: 'google', accountId: 'act_1' }),
  makeObservation({ platform: 'meta', accountId: 'act_2' }),
];
runPlatformConnectorContract('StaticPlatformConnector', () => new StaticPlatformConnector('meta', observations), {
  account: { accountId: 'act_1' },
  window: { from: '2026-10-25T00:00:00.000Z', to: '2026-10-26T00:00:00.000Z', granularity: 'hour' },
});
