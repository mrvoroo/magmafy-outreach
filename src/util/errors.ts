/** Error classes: retryable (transient) vs fatal (do not retry). */
export class RetryableError extends Error { readonly retryable = true; }
export class FatalError extends Error { readonly retryable = false; }
export async function withRetry<T>(fn: () => Promise<T>, o: { tries?: number; baseMs?: number; sleep?: (ms: number) => Promise<void> } = {}): Promise<T> {
  const tries = o.tries ?? 3, base = o.baseMs ?? 500, sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    try { return await fn(); } catch (e) {
      last = e;
      if (e instanceof FatalError || (e as { retryable?: boolean })?.retryable === false) throw e;
      if (i < tries - 1) await sleep(base * 2 ** i);
    }
  }
  throw last;
}
export async function withTimeout<T>(p: Promise<T>, ms: number, what = 'operation'): Promise<T> {
  let t: NodeJS.Timeout;
  const to = new Promise<never>((_, rej) => { t = setTimeout(() => rej(new RetryableError(`${what} timed out after ${ms}ms`)), ms); });
  try { return await Promise.race([p, to]); } finally { clearTimeout(t!); }
}
