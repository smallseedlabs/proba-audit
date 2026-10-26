import type { StoredAuditEvent } from '../domain/audit.js';
import { computeEventHash, digestAuditContent } from '../domain/chain.js';
import type { AuditContentStore } from '../ports/audit-content-store.js';
import type { AuditStore } from '../ports/audit-store.js';
import { validateStoredAuditEvent } from './protocol.js';

/** Range on `ingestedAt`: `from` inclusive, `to` exclusive. Omit both to verify the whole workspace chain. */
export interface ChainRange {
  from?: string;
  to?: string;
}

export type ChainProblemType =
  | 'invalid_event' // fails the protocol StoredAuditEvent schema
  | 'workspace_mismatch' // event of another workspace in this chain
  | 'hash_mismatch' // stored hash != recomputed hash: the event was altered
  | 'broken_link' // prevHash != hash of the previous event: an event is missing, reordered or replaced
  | 'bad_genesis' // first event of a chain has a prevHash, or the first event of a range does not follow its predecessor
  | 'non_monotonic_ingested_at' // ingestedAt does not strictly increase
  | 'content_mismatch'; // the stored raw text does not match the event's contentDigest (only checked with a content store)

export interface ChainProblem {
  type: ChainProblemType;
  eventId: string;
  detail: string;
}

export interface ChainVerification {
  workspaceId: string;
  range: ChainRange;
  /** True when nothing wrong was found in the events that were checked. */
  ok: boolean;
  /** Number of events checked. */
  checked: number;
  firstEventId: string | null;
  lastEventId: string | null;
  /** Hash of the last event checked: the anchor to continue from. */
  lastHash: string | null;
  /** First problems found, at most `maxProblems`. */
  problems: ChainProblem[];
  /** False when verification stopped early after `maxProblems` problems. */
  complete: boolean;
  /** Present (true) only when the `maxEvents` bound stopped verification before the range was exhausted. */
  truncated?: boolean;
  /**
   * Present when a content store was given. `checked`: events with a contentDigest whose text was compared,
   * `missing`: events whose text is not in the store (never stored, or removed by retention: not a problem,
   * the digest in the chain still proves what it was), mismatched ones are reported as `content_mismatch` problems.
   */
  content?: { checked: number; missing: number };
}

export interface VerifyChainOptions {
  /** Events fetched per page. Default 1000. */
  pageSize?: number;
  /** Stop after this many problems. Default 50. */
  maxProblems?: number;
  /** Stop after checking this many events (a bound for requests served on demand). Default: no bound. */
  maxEvents?: number;
  /** Also compare the stored raw text of events that have a contentDigest with that digest. */
  contentStore?: AuditContentStore;
}

/**
 * Verify the hash chain of one workspace over an ingestedAt range.
 *
 * For every event it checks: the protocol schema, the workspace, that `hash`
 * equals the recomputed hash, that `prevHash` equals the previous event's hash
 * and that ingestedAt strictly increases. The first event is anchored: with no
 * `range.from` it must be the genesis (prevHash null); with `range.from` it must
 * follow the real predecessor event (the last event before `from`), whose own hash
 * is verified too.
 *

 * With `options.contentStore`, the raw text of every event that has a `contentDigest` is read back and its
 * digest compared (`content_mismatch`): the chain covers the digest, this proves the text still matches it.
 *
 * Reads the workspace in pages, so it is safe on large chains, but ClickHouse has
 * no index on ingestedAt: run it as a maintenance job, not per request.
 */
export async function verifyChain(
  store: AuditStore,
  workspaceId: string,
  range: ChainRange = {},
  options: VerifyChainOptions = {}
): Promise<ChainVerification> {
  const pageSize = options.pageSize ?? 1000;
  const maxProblems = options.maxProblems ?? 50;
  const maxEvents = options.maxEvents ?? Infinity;
  let truncated = false;
  const problems: ChainProblem[] = [];
  const report = (type: ChainProblemType, e: StoredAuditEvent, detail: string): void => {
    if (problems.length < maxProblems) problems.push({ type, eventId: e.eventId, detail });
  };

  // Anchor: what the first event's prevHash must be.
  let expectedPrev: string | null = null;
  let previousIngestedAt: string | undefined;
  if (range.from !== undefined) {
    const [predecessor] = await store.readChain(workspaceId, { to: range.from, order: 'desc', limit: 1 });
    if (predecessor) {
      if (computeEventHash(predecessor) !== predecessor.hash) {
        report('hash_mismatch', predecessor, 'predecessor of the range has a hash that does not match its content');
      }
      expectedPrev = predecessor.hash;
      previousIngestedAt = predecessor.ingestedAt;
    }
  }

  let checked = 0;
  let first: StoredAuditEvent | null = null;
  let last: StoredAuditEvent | null = null;
  let cursor: { ingestedAt: string; eventId: string } | undefined;
  let isFirst = true;
  let contentChecked = 0;
  let contentMissing = 0;

  while (problems.length < maxProblems) {
    const page = await store.readChain(workspaceId, {
      from: range.from,
      to: range.to,
      after: cursor,
      order: 'asc',
      limit: pageSize,
    });
    if (page.length === 0) break;

    const contents = new Map<string, { contentDigest: string; digest: string }>();
    if (options.contentStore) {
      const withDigest = page.filter((e) => e.contentDigest !== undefined).map((e) => e.eventId);
      if (withDigest.length > 0) {
        for (const row of await options.contentStore.getMany(workspaceId, withDigest)) {
          contents.set(row.eventId, { contentDigest: row.contentDigest, digest: digestAuditContent(row.content) });
        }
      }
    }

    for (const e of page) {
      if (checked >= maxEvents) {
        truncated = true;
        break;
      }
      checked += 1;
      first ??= e;
      last = e;

      if (!validateStoredAuditEvent(e).success) report('invalid_event', e, 'fails the StoredAuditEvent schema');
      if (e.workspaceId !== workspaceId) report('workspace_mismatch', e, `belongs to workspace ${e.workspaceId}`);
      if (computeEventHash(e) !== e.hash) report('hash_mismatch', e, 'stored hash does not match the event content');
      if (e.prevHash !== expectedPrev) {
        const detail = `prevHash ${e.prevHash ?? 'null'} does not match the previous hash ${expectedPrev ?? 'null'}`;
        report(isFirst ? 'bad_genesis' : 'broken_link', e, detail);
      }
      if (previousIngestedAt !== undefined && Date.parse(e.ingestedAt) <= Date.parse(previousIngestedAt)) {
        report('non_monotonic_ingested_at', e, `ingestedAt ${e.ingestedAt} is not after ${previousIngestedAt}`);
      }

      if (options.contentStore && e.contentDigest !== undefined) {
        const stored = contents.get(e.eventId);
        if (!stored) {
          contentMissing += 1;
        } else {
          contentChecked += 1;
          if (stored.digest !== e.contentDigest || stored.contentDigest !== e.contentDigest) {
            report('content_mismatch', e, 'the stored raw text does not match the digest in the chain');
          }
        }
      }

      // Continue from what is stored, so one tampered event is reported once, not for every successor.
      expectedPrev = e.hash;
      previousIngestedAt = e.ingestedAt;
      isFirst = false;
    }
    if (truncated || page.length < pageSize) break;
    const tail = page[page.length - 1] as StoredAuditEvent;
    cursor = { ingestedAt: tail.ingestedAt, eventId: tail.eventId };
  }

  return {
    workspaceId,
    range,
    ok: problems.length === 0,
    checked,
    firstEventId: first?.eventId ?? null,
    lastEventId: last?.eventId ?? null,
    lastHash: last?.hash ?? null,
    problems,
    complete: problems.length < maxProblems,
    ...(truncated ? { truncated: true } : {}),
    ...(options.contentStore ? { content: { checked: contentChecked, missing: contentMissing } } : {}),
  };
}
