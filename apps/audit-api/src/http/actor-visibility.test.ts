import { describe, expect, it } from 'vitest';
import { applyActorVisibility, pseudonymizeActorId } from './actor-visibility.js';

describe('pseudonymizeActorId', () => {
  it('is stable for the same workspace and actor, and differs across workspaces', () => {
    const a = pseudonymizeActorId('seedbed', 'uid-alice');
    const b = pseudonymizeActorId('seedbed', 'uid-alice');
    const c = pseudonymizeActorId('other', 'uid-alice');
    const d = pseudonymizeActorId('seedbed', 'uid-bob');
    expect(a).toBe(b);
    expect(a).toMatch(/^actor_[0-9a-f]{16}$/);
    expect(a).not.toBe(c);
    expect(a).not.toBe(d);
    expect(a).not.toContain('uid-alice');
  });

  it('is idempotent on an already-pseudonymised id', () => {
    const once = pseudonymizeActorId('seedbed', 'uid-alice');
    expect(pseudonymizeActorId('seedbed', once)).toBe(once);
  });
});

describe('applyActorVisibility', () => {
  const event = { actor: { type: 'user' as const, id: 'uid-alice' }, action: 'goal.created' };

  it('leaves the real id for administrators', () => {
    expect(applyActorVisibility(event, 'admin', 'seedbed').actor.id).toBe('uid-alice');
  });

  it('replaces the id with a stable pseudonym for viewers', () => {
    const masked = applyActorVisibility(event, 'viewer', 'seedbed');
    expect(masked.actor.id).toBe(pseudonymizeActorId('seedbed', 'uid-alice'));
    expect(masked.actor.type).toBe('user');
    expect(masked.action).toBe('goal.created');
  });
});
