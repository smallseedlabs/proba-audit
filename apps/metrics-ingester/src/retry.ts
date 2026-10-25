import { ConnectorError, RateLimitedError } from '@smallseedlabs/proba-audit-core';

export interface RetryPolicy {
  maxAttempts: number;
  baseMs: number;
  maxMs: number;
  /** Longest wait the engine accepts for a platform rate-limit hint; a longer hint ends the run instead. */
  maxRateLimitWaitMs: number;
}

/** Why a run (or one step of it) stopped after the retries were used up. */
export class SyncStepError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly attempts: number,
    /** When the platform said to come back, in ms from now. The scheduler honours it. */
    readonly retryAfterMs?: number,
    override readonly cause?: unknown
  ) {
    super(message);
    this.name = 'SyncStepError';
  }
}

export interface RetryHooks {
  sleep(ms: number): Promise<void>;
  /** Uniform [0,1). */
  random(): number;
  onRetry?(info: { attempt: number; delayMs: number; code: string; message: string }): void;
}

export function errorCode(err: unknown): string {
  return err instanceof ConnectorError ? err.code : 'error';
}

/** Strip anything that looks like a credential from a message before it is logged or audited. */
export function redactSecrets(message: string): string {
  return message
    .replace(/(bearer|token|secret|password|passwd|api[_-]?key|authorization)(["']?\s*[:=]\s*|\s+)[^\s,;"']+/gi, '$1=[redacted]')
    .slice(0, 500);
}

/**
 * Exponential backoff with full jitter. Rate-limit errors wait for the platform's
 * hint when it gave one. Non-retryable connector errors (auth, bad request) end
 * immediately: trying again cannot help. Anything else (network, store hiccup) is
 * treated as transient.
 */
export async function withRetry<T>(fn: () => Promise<T>, policy: RetryPolicy, hooks: RetryHooks): Promise<T> {
  let attempt = 0;
  for (;;) {
    attempt += 1;
    try {
      return await fn();
    } catch (err) {
      const message = redactSecrets(err instanceof Error ? err.message : String(err));
      const code = errorCode(err);
      const retryable = err instanceof ConnectorError ? err.retryable : true;
      const hint = err instanceof RateLimitedError ? err.retryAfterMs : undefined;
      if (!retryable) throw new SyncStepError(message, code, attempt, undefined, err);
      if (hint !== undefined && hint > policy.maxRateLimitWaitMs) {
        // Too long to wait inside a run: give up now and let the scheduler come back after the hint.
        throw new SyncStepError(message, code, attempt, hint, err);
      }
      if (attempt >= policy.maxAttempts) throw new SyncStepError(message, code, attempt, hint, err);
      const backoff = Math.min(policy.maxMs, policy.baseMs * 2 ** (attempt - 1));
      const delayMs = hint !== undefined ? hint : Math.round(backoff * (0.5 + hooks.random() * 0.5));
      hooks.onRetry?.({ attempt, delayMs, code, message });
      await hooks.sleep(delayMs);
    }
  }
}
