import { logger } from '@/common/logger/logger';

export interface RetryOptions {
  maxAttempts: number;
  initialDelayMs: number;
  maxDelayMs: number;
  /** 0–1 fraction of delay to randomise (jitter reduces thundering-herd) */
  jitterFactor?: number;
  /** Return true for errors that should trigger a retry; defaults to all errors */
  isRetryable?: (err: unknown) => boolean;
}

/**
 * Retry `fn` with exponential backoff + full jitter.
 *
 * Design: delay = min(maxDelay, initial * 2^attempt) * (1 ± jitter)
 * Full jitter (not equal jitter) is recommended to spread load after outages.
 */
export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  opts: RetryOptions,
): Promise<T> {
  const { maxAttempts, initialDelayMs, maxDelayMs, jitterFactor = 0.3, isRetryable } = opts;
  let lastErr: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;

      if (isRetryable && !isRetryable(err)) {
        throw err;
      }

      if (attempt === maxAttempts) break;

      const base = Math.min(maxDelayMs, initialDelayMs * Math.pow(2, attempt - 1));
      const jitter = base * jitterFactor * (Math.random() * 2 - 1);
      const delay = Math.max(0, Math.round(base + jitter));

      logger.warn(
        { attempt, maxAttempts, delayMs: delay, err },
        'Retrying after failure',
      );

      await sleep(delay);
    }
  }

  throw lastErr;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
