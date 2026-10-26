/**
 * Chain anchors: the latest head of a workspace's hash chain, signed (HMAC-SHA256) and kept OUTSIDE the audit store.
 *
 * The hash chain proves that no event was edited, and that none was removed from the middle. It cannot prove that
 * the NEWEST events were not deleted: a shorter chain is still a valid chain. An anchor can: it remembers how long
 * the chain was and what its head was, in a separate store with a separate credential, signed with a key the audit
 * store never sees. Pure functions, no I/O.
 *
 * Signed message: `proba.anchor.v1\n<workspaceId>\n<headHash>\n<count>\n<timestamp>`.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

/** What an anchor says about a chain. */
export interface ChainAnchorClaim {
  workspaceId: string;
  /** `hash` of the newest event of the chain when the anchor was made. */
  headHash: string;
  /** How many events the chain had (a chain is only ever appended to, so this never goes down). */
  count: number;
  /** `ingestedAt` of that newest event, ISO 8601 UTC. It places the anchor on the chain's time axis. */
  timestamp: string;
}

export interface ChainAnchor extends ChainAnchorClaim {
  /** Lower-case hex HMAC-SHA256 over the claim. */
  signature: string;
}

/** The development/test key used when ANCHOR_HMAC_KEY is empty outside production. NEVER a real key. */
export const DEV_ANCHOR_HMAC_KEY = 'proba-audit-dev-anchor-key-not-for-production';

/** Production keys must be at least this long. */
export const MIN_ANCHOR_KEY_LENGTH = 32;

function message(claim: ChainAnchorClaim): string {
  return `proba.anchor.v1\n${claim.workspaceId}\n${claim.headHash}\n${claim.count}\n${claim.timestamp}`;
}

export function signAnchor(key: string, claim: ChainAnchorClaim): ChainAnchor {
  const { workspaceId, headHash, count, timestamp } = claim;
  const signature = createHmac('sha256', key).update(message(claim)).digest('hex');
  return { workspaceId, headHash, count, timestamp, signature };
}

/** True when the anchor was signed with `key` and not changed since (constant-time comparison). */
export function verifyAnchorSignature(key: string, anchor: ChainAnchor): boolean {
  const expected = Buffer.from(signAnchor(key, anchor).signature, 'hex');
  const given = Buffer.from(anchor.signature, 'hex');
  return given.length === expected.length && timingSafeEqual(given, expected);
}
