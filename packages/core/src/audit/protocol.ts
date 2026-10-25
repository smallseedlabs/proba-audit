/**
 * The only place proba-audit pulls runtime helpers from the protocol package.
 * Apps import these through core so that the protocol dependency is declared
 * once (in packages/core) and schemas are never copied.
 */
export {
  AUDIT_ACTIONS,
  buildAuditEvent,
  canonicalizeAuditEvent,
  generateSpanId,
  validateAuditEvent,
  validateStoredAuditEvent,
} from '@smallseedlabs/proba-protocol/audit';
export type { AuditActor, AuditEventDraft, AuditTarget } from '@smallseedlabs/proba-protocol/audit';
