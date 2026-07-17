// Run `fn` over `items` with at most `limit` in flight. This bounds the
// concurrency of (otherwise unbounded) Promise.all fan-outs so a PR with
// hundreds of changed files, or dozens of violations needing an LLM call,
// can't open thousands of simultaneous network connections (audits P1-C, P2-E).
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < items.length) {
      const i = cursor++;
      results[i] = await fn(items[i] as T, i);
    }
  };
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker);
  await Promise.all(workers);
  return results;
}

// Race `promise` against a timeout. On expiry the returned promise rejects with
// the provided (or a default) error; `promise` is left to settle on its own,
// which is acceptable for a detached background task (audit P2-C). Optionally
// takes an external AbortSignal so a single deadline can both reject this race
// AND abort any abortable child work (e.g. a Semgrep subprocess, audit P2-4).
export function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  external?: AbortSignal,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`operation timed out after ${ms}ms`)), ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new Error("operation aborted"));
    };
    if (external) {
      if (external.aborted) {
        clearTimeout(timer);
        reject(new Error("operation aborted"));
        return;
      }
      external.addEventListener("abort", onAbort, { once: true });
    }
    promise.then(
      (v) => {
        clearTimeout(timer);
        external?.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        external?.removeEventListener("abort", onAbort);
        reject(e);
      },
    );
  });
}
