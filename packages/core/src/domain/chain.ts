/**
 * Hash chain rules for stored audit events. Pure functions, no I/O.
 *
 * Scope: one chain PER WORKSPACE. The chain order is the order the consumer
 * ingested events, expressed as a strictly increasing `ingestedAt` per
 * workspace (see nextIngestedAt), so the head of a chain is always "the event
 * with the greatest ingestedAt".
 *
 * Hash rule (documented in docs/ARCHITECTURE.md):
 *   hash = sha256_hex( canonicalizeAuditEvent( storedEvent without `hash` ) )
 * The canonical string is produced by the protocol. It therefore covers the
 * producer fields, the derived tags, prevHash, ingestedAt and schemaVersion, so
 * changing any stored field breaks the hash, and prevHash links the chain.
 *
 * "Content" (used to tell an identical redelivery from a conflicting event with
 * the same eventId) is the same canonical string *without* the four chain fields
 * prevHash, hash, ingestedAt and schemaVersion, after normalizeForStorage.
 *
 * Raw text (AuditEvent.content) is NOT part of a stored event. prepareForStorage takes it out and
 * puts its SHA-256 digest in `contentDigest`, which is a stored field like any other and therefore
 * covered by the hash. The text lives in the AuditContentStore; changing or swapping it no longer
 * matches the digest, and deleting it (retention) leaves the chain intact.
 */

import { createHash } from 'node:crypto';
import type { AuditEvent, StoredAuditEvent } from './audit.js';
import { canonicalizeAuditContent, canonicalizeAuditEvent, type AuditContent } from '../audit/protocol.js';

export const STORED_AUDIT_SCHEMA_VERSION = 1;

/** The link a new event must chain onto. */
export interface ChainLink {
  hash: string;
  ingestedAt: string;
}

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

/** SHA-256 (lower-case hex) of the canonical form of an event's raw text: the `contentDigest` of the stored event. */
export function digestAuditContent(content: AuditContent): string {
  return sha256(canonicalizeAuditContent(content));
}

/** An event as stored: without its raw text, with the digest of it. */
export type PreparedAuditEvent = AuditEvent & { contentDigest?: string };

/**
 * Take the raw text out of an event: the event without `content`, with `contentDigest` set when it had
 * some. Events without content are returned unchanged. The text itself is returned for the content store.
 */
export function splitContent(event: AuditEvent | PreparedAuditEvent): { event: PreparedAuditEvent; content?: AuditContent } {
  const { content, ...rest } = event as PreparedAuditEvent;
  if (content === undefined) return { event: rest };
  return { event: { ...rest, contentDigest: digestAuditContent(content) }, content };
}

/** Tags derived from the event itself: category, outcome, service and (when set) risk. */
export function deriveTags(event: AuditEvent): string[] {
  const tags = [`category:${event.category}`, `outcome:${event.outcome}`, `service:${event.service}`];
  if (event.riskLevel !== undefined) tags.push(`risk:${event.riskLevel}`);
  return tags;
}

/**
 * Round-trips values the way storage does, so a stored event hashes the same
 * after it is read back: timestamps to millisecond precision, cost.amount to 8
 * decimals (Decimal(18,8)). Idempotent.
 */
export function normalizeForStorage<T extends AuditEvent>(event: T): T {
  const normalized: T = { ...event, occurredAt: new Date(event.occurredAt).toISOString() };
  if (event.cost?.amount !== undefined) {
    normalized.cost = { ...event.cost, amount: Math.round(event.cost.amount * 1e8) / 1e8 };
  }
  return normalized;
}

/** The event as it will be stored (before chain fields): normalised, producer tags first, then derived tags, no duplicates. */
export function prepareForStorage(event: AuditEvent): PreparedAuditEvent {
  const normalized = normalizeForStorage(splitContent(event).event);
  const tags = [...new Set([...(normalized.tags ?? []), ...deriveTags(normalized)])];
  return { ...normalized, tags };
}

/** Canonical content string: the event without its chain fields. */
export function canonicalContent(event: AuditEvent | StoredAuditEvent): string {
  // An incoming event (with its text) and the stored one (with the digest) must compare equal.
  const comparable = splitContent(event).event;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { prevHash, hash, ingestedAt, schemaVersion, ...content } = comparable as Partial<StoredAuditEvent> & AuditEvent;
  return canonicalizeAuditEvent(content);
}

/** sha256 of the canonical content. Equal content hash means an identical event. */
export function contentHash(event: AuditEvent | StoredAuditEvent): string {
  return sha256(canonicalContent(event));
}

/** True when two events (stored or not) carry the same content, ignoring chain fields. */
export function sameContent(a: AuditEvent | StoredAuditEvent, b: AuditEvent | StoredAuditEvent): boolean {
  return canonicalContent(a) === canonicalContent(b);
}

/** Hash of a stored event: sha256 of its canonical form without the `hash` field. */
export function computeEventHash(event: StoredAuditEvent): string {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { hash, ...rest } = event;
  return sha256(canonicalizeAuditEvent(rest as unknown as AuditEvent));
}

/**
 * Next ingestedAt for a workspace: the clock time, but at least 1 ms after the
 * previous event's, so ingestedAt is strictly increasing within a chain.
 * Under a sustained rate above 1000 events/s/workspace it runs ahead of the clock.
 */
export function nextIngestedAt(nowIso: string, previous?: string): string {
  const now = Date.parse(nowIso);
  if (previous === undefined) return new Date(now).toISOString();
  return new Date(Math.max(now, Date.parse(previous) + 1)).toISOString();
}

/**
 * Chain one event onto `head` (null for the first event of a workspace).
 * Returns the StoredAuditEvent ready to append.
 */
export function chainEvent(event: AuditEvent, head: ChainLink | null, nowIso: string): StoredAuditEvent {
  const base = {
    ...prepareForStorage(event),
    prevHash: head?.hash ?? null,
    ingestedAt: nextIngestedAt(nowIso, head?.ingestedAt),
    schemaVersion: STORED_AUDIT_SCHEMA_VERSION,
  };
  return { ...base, hash: computeEventHash({ ...base, hash: '' }) };
}
