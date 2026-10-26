import { afterEach, describe, expect, it } from 'vitest';
import { buildAuditContent, digestAuditContent, verifyChain } from '@smallseedlabs/proba-audit-core';
import {
  InMemoryAuditContentStore,
  InMemoryAuditStore,
  InMemoryEventBus,
  ManualClock,
  SequentialIdGenerator,
} from '@smallseedlabs/proba-audit-adapters';
import { ConsumerHarness, makeEvent } from './harness.testing.js';

const open: ConsumerHarness[] = [];
function setup(enabled: boolean, contentStore: InMemoryAuditContentStore = new InMemoryAuditContentStore()) {
  const bus = new InMemoryEventBus();
  const store = new InMemoryAuditStore();
  const h = new ConsumerHarness({
    bus,
    store,
    contentStore,
    clock: new ManualClock('2026-10-25T10:05:00.000Z'),
    ids: new SequentialIdGenerator(),
    topic: 'audit',
    group: 'audit-consumer',
    selfAudit: false,
    overrides: { contentEnabled: enabled },
  });
  open.push(h);
  return { h, store, contentStore };
}
afterEach(async () => {
  while (open.length) await open.pop()!.close();
});

const TEXT = 'Pause the Black Friday campaign please';

describe('AuditConsumer: raw text', () => {
  it('splits the text from the event: the event keeps only the digest, the text goes to the content store', async () => {
    const { h, store, contentStore } = setup(true);
    const content = buildAuditContent('user_message', TEXT);
    const event = makeEvent({ action: 'thread.message_received', content });
    await h.publish(event);
    const { result } = await h.pump();
    expect(result.contentStored).toBe(1);
    const [row] = (await store.readChain('seedbed'));
    expect(row.contentDigest).toBe(digestAuditContent(content));
    expect(JSON.stringify(row)).not.toContain(TEXT);
    expect('content' in row).toBe(false);
    const text = await contentStore.get('seedbed', event.eventId);
    expect(text).toMatchObject({ workspaceId: 'seedbed', eventId: event.eventId, content, contentDigest: row.contentDigest });
  });

  it('puts the digest into the hash chain: changing it breaks the hash, and changing the text is caught', async () => {
    const { h, store, contentStore } = setup(true);
    const event = makeEvent({ content: buildAuditContent('user_message', TEXT) });
    await h.publish(event, makeEvent());
    await h.pump();
    const clean = await verifyChain(store, 'seedbed', {}, { contentStore });
    expect(clean).toMatchObject({ ok: true, checked: 2, content: { checked: 1, missing: 0 } });

    // Text altered after the fact: the digest in the chain no longer matches it.
    contentStore.tamper('seedbed', event.eventId, 'Delete the Black Friday campaign please');
    const textTampered = await verifyChain(store, 'seedbed', {}, { contentStore });
    expect(textTampered.ok).toBe(false);
    expect(textTampered.problems.map((p) => p.type)).toEqual(['content_mismatch']);

    // Digest rewritten in the event to fit the altered text: the event hash no longer matches.
    const rows = await store.readChain('seedbed');
    const forged = { ...rows[0], contentDigest: digestAuditContent(buildAuditContent('user_message', 'Delete the Black Friday campaign please')) };
    const forgedStore = new InMemoryAuditStore();
    await forgedStore.appendBatch([forged, rows[1]]);
    const digestTampered = await verifyChain(forgedStore, 'seedbed', {}, {});
    expect(digestTampered.problems.map((p) => p.type)).toContain('hash_mismatch');
  });

  it('treats text removed by retention as missing, not as a broken chain', async () => {
    const { h, store, contentStore } = setup(true);
    const event = makeEvent({ content: buildAuditContent('brain_reply', 'ok') });
    await h.publish(event);
    await h.pump();
    contentStore.delete('seedbed', event.eventId);
    const res = await verifyChain(store, 'seedbed', {}, { contentStore });
    expect(res).toMatchObject({ ok: true, content: { checked: 0, missing: 1 } });
  });

  it('drops the text, and stores no digest, when content is disabled', async () => {
    const { h, store, contentStore } = setup(false);
    const event = makeEvent({ content: buildAuditContent('user_message', TEXT) });
    await h.publish(event);
    const { result } = await h.pump();
    expect(result.contentDropped).toBe(1);
    expect(result.contentStored).toBe(0);
    const [row] = (await store.readChain('seedbed'));
    expect(row.contentDigest).toBeUndefined();
    expect(JSON.stringify(row)).not.toContain(TEXT);
    expect(await contentStore.get('seedbed', event.eventId)).toBeNull();
    expect(h.logger.records.some((r) => r.level === 'warn' && String(r.msg).includes('dropped'))).toBe(true);
    expect(JSON.stringify(h.logger.records)).not.toContain(TEXT);
  });

  it('stores an event without text exactly as before, whether content is enabled or not', async () => {
    for (const enabled of [true, false]) {
      const { h, store, contentStore } = setup(enabled);
      const event = makeEvent();
      await h.publish(event);
      const { result } = await h.pump();
      expect(result).toMatchObject({ contentStored: 0, contentDropped: 0 });
      expect((await store.readChain('seedbed'))[0].contentDigest).toBeUndefined();
      expect(await contentStore.get('seedbed', event.eventId)).toBeNull();
    }
  });

  it('is idempotent: a redelivered event does not duplicate or change the stored text, and restores text lost between the two writes', async () => {
    const { h, store, contentStore } = setup(true);
    const event = makeEvent({ content: buildAuditContent('user_message', TEXT) });
    await h.publish(event);
    await h.pump();
    contentStore.delete('seedbed', event.eventId); // as if the first attempt had died before the text write
    await h.publish(event);
    const { result } = await h.pump();
    expect(result.duplicates).toBe(1);
    expect((await store.readChain('seedbed'))).toHaveLength(1);
    expect(await contentStore.get('seedbed', event.eventId)).not.toBeNull();
  });
});
