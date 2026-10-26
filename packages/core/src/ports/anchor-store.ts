/**
 * AnchorStore port: where the signed head of each workspace's hash chain is kept, OUTSIDE the audit store.
 *
 * Without it, deleting the newest events of a workspace leaves a perfectly valid, shorter chain. The anchor
 * (see domain/anchor.ts) remembers the length and head the chain once had, so verifyChain can report
 * `tail_truncated`. Keep it in a different system than the AuditStore and give it a different credential:
 * whoever can rewrite the audit store must not be able to rewrite the anchors. The adapter holds the HMAC key
 * (ANCHOR_HMAC_KEY), signs on `put` and verifies on `get`.
 */

import type { ChainAnchor, ChainAnchorClaim } from '../domain/anchor.js';

/** `get` found an anchor whose signature does not verify: it was changed, or signed with another key. */
export class AnchorTamperedError extends Error {
  constructor(readonly workspaceId: string) {
    super(`The chain anchor of workspace ${workspaceId} does not carry a valid signature (changed, or signed with another ANCHOR_HMAC_KEY)`);
    this.name = 'AnchorTamperedError';
  }
}

export interface AnchorStore {
  /**
   * Sign and store the claim as the latest anchor of its workspace. An anchor never goes backwards: when the stored
   * anchor already has a higher `count`, nothing is written. Returns the anchor that is stored afterwards.
   */
  put(claim: ChainAnchorClaim): Promise<ChainAnchor>;
  /** The latest anchor of a workspace, or null. Throws AnchorTamperedError when its signature does not verify. */
  get(workspaceId: string): Promise<ChainAnchor | null>;
  /** Throws if the backing service is unreachable. */
  ping(): Promise<void>;
  close(): Promise<void>;
}
