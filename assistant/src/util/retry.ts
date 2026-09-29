/** Exponential backoff delay in ms: 1m, 2m, 4m … capped at 60m. */
export function backoffMs(attempts: number, baseMs = 60_000, capMs = 60 * 60_000): number {
  return Math.min(capMs, baseMs * 2 ** Math.max(0, attempts - 1));
}

export async function withRetry<T>(fn: () => Promise<T>, tries = 3, baseMs = 500): Promise<T> {
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      if (i < tries - 1) await new Promise((r) => setTimeout(r, baseMs * 2 ** i));
    }
  }
  throw last;
}
