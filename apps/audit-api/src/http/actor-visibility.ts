import { createHash } from 'node:crypto';

/**
 * Role-based actor visibility for audit reads.
 *
 * Administrators see the real `actor.id`. Viewers see a stable pseudonymous hash derived from
 * workspace + actor id (same person always maps to the same token within a workspace; the real
 * id cannot be recovered from it). An optional "own events only" mode is documented for a later
 * flag (`AUDIT_API_VIEWER_OWN_EVENTS_ONLY`) and is not enabled here.
 */

const PSEUDONYM_PREFIX = 'actor_';
const PSEUDONYM_HEX_LEN = 16;

/** Stable, non-reversible actor id for viewers. Idempotent on already-pseudonymised values. */
export function pseudonymizeActorId(workspaceId: string, actorId: string): string {
  if (actorId.startsWith(PSEUDONYM_PREFIX) && /^actor_[0-9a-f]+$/i.test(actorId)) return actorId;
  const digest = createHash('sha256').update(`${workspaceId}\0${actorId}`, 'utf8').digest('hex');
  return `${PSEUDONYM_PREFIX}${digest.slice(0, PSEUDONYM_HEX_LEN)}`;
}

/** Replace `actor.id` for non-admin roles. Admins get the event unchanged. */
export function applyActorVisibility<T extends { actor: { type: string; id: string } }>(
  event: T,
  role: string,
  workspaceId: string
): T {
  if (role === 'admin') return event;
  return {
    ...event,
    actor: { ...event.actor, id: pseudonymizeActorId(workspaceId, event.actor.id) },
  };
}
