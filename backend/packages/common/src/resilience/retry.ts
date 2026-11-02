export interface RetryOptions {
  /** Total attempts including the first */
  attempts?: number;
  baseMs?: number;
  maxMs?: number;
  /** Whether an error is worth another attempt (default: always) */
  retryOn?: (error: unknown, attempt: number) => boolean;
  /** Absolute deadline (epoch ms): no attempt starts after it */
  deadline?: number;
  random?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Exponential backoff with full jitter (AWS Architecture Blog, "Exponential Backoff And Jitter"): the delay
 * before attempt n is uniform in [0, min(maxMs, baseMs * 2^n)], which spreads retries from many clients
 * instead of synchronising them into waves that hit a recovering service all at once.
 */
export async function retry<T>(fn: (attempt: number) => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const attempts = options.attempts ?? 3;
  const baseMs = options.baseMs ?? 100;
  const maxMs = options.maxMs ?? 2_000;
  const random = options.random ?? Math.random;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (error) {
      lastError = error;
      const isLast = attempt === attempts - 1;
      if (isLast || (options.retryOn && !options.retryOn(error, attempt))) throw error;
      const delay = Math.floor(random() * Math.min(maxMs, baseMs * 2 ** attempt));
      if (options.deadline !== undefined && Date.now() + delay >= options.deadline) throw error;
      await sleep(delay);
    }
  }
  throw lastError;
}
