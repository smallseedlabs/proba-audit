import { DEV_ANCHOR_HMAC_KEY, MIN_ANCHOR_KEY_LENGTH, type AppConfig } from '@smallseedlabs/proba-audit-core';

/** In production the anchors need a real ANCHOR_HMAC_KEY: without one anyone who can write the anchor store could forge them. */
export class AnchorKeyRequiredError extends Error {
  constructor(reason: string) {
    super(`ANCHOR_HMAC_KEY ${reason}. Set a secret of at least ${MIN_ANCHOR_KEY_LENGTH} characters (for example \`openssl rand -hex 32\`); it signs the chain anchors.`);
    this.name = 'AnchorKeyRequiredError';
  }
}

/**
 * The key that signs chain anchors. Production: ANCHOR_HMAC_KEY must be set and long enough (AnchorKeyRequiredError).
 * Elsewhere an empty key falls back to a fixed development key, so a local stack and the tests need no secret.
 */
export function resolveAnchorHmacKey(config: AppConfig): string {
  const key = config.anchors.hmacKey;
  if (config.isProduction) {
    if (key === '') throw new AnchorKeyRequiredError('is required when NODE_ENV=production');
    if (key.length < MIN_ANCHOR_KEY_LENGTH) throw new AnchorKeyRequiredError('is too short');
    if (key === DEV_ANCHOR_HMAC_KEY) throw new AnchorKeyRequiredError('is the public development key');
    return key;
  }
  return key === '' ? DEV_ANCHOR_HMAC_KEY : key;
}
