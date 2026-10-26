import {
  AnchorTamperedError,
  signAnchor,
  verifyAnchorSignature,
  type AnchorStore,
  type ChainAnchor,
  type ChainAnchorClaim,
} from '@smallseedlabs/proba-audit-core';

export interface InMemoryAnchorStoreOptions {
  hmacKey: string;
}

/** In-process AnchorStore. Lost on restart and not shared between replicas: for tests and throwaway local runs. */
export class InMemoryAnchorStore implements AnchorStore {
  private readonly rows = new Map<string, ChainAnchor>();
  private readonly key: string;

  constructor(options: InMemoryAnchorStoreOptions) {
    this.key = options.hmacKey;
  }

  async put(claim: ChainAnchorClaim): Promise<ChainAnchor> {
    const current = this.rows.get(claim.workspaceId);
    if (current && current.count > claim.count) return { ...current };
    const anchor = signAnchor(this.key, claim);
    this.rows.set(claim.workspaceId, anchor);
    return { ...anchor };
  }

  async get(workspaceId: string): Promise<ChainAnchor | null> {
    const row = this.rows.get(workspaceId);
    if (!row) return null;
    if (!verifyAnchorSignature(this.key, row)) throw new AnchorTamperedError(workspaceId);
    return { ...row };
  }

  /** Test hook: overwrite a stored anchor without signing, to simulate tampering. */
  tamper(workspaceId: string, change: Partial<ChainAnchor>): void {
    const row = this.rows.get(workspaceId);
    if (row) this.rows.set(workspaceId, { ...row, ...change });
  }

  async ping(): Promise<void> {
    // Always reachable.
  }

  async close(): Promise<void> {
    // Nothing to release.
  }
}
