// Give a slow computation a time budget (BAC-76). Pure: no Remix, no server imports.

/** Resolves with the value if `promise` settles within `ms`, otherwise with `null`. The promise itself
 *  keeps running (a shared stale-while-revalidate compute stays in flight for the next caller). A
 *  rejection inside the budget still rejects; one after it is swallowed, never an unhandled rejection. */
export function withBudget<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
  });
  promise.catch(() => undefined);
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}
