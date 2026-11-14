// Tiny in-process TTL cache with request coalescing. Expensive aggregations
// (performance figures, label lists) are shared across panels and across the
// auto-refresh instead of recomputed on every loader call. Caching the
// in-flight promise means concurrent callers (e.g. the Overview and the
// Performance page asking for the same services table) collapse into ONE
// backend round-trip.
type Entry = { at: number; val: Promise<unknown> };
const store = new Map<string, Entry>();

export function cached<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
  const now = Date.now();
  const hit = store.get(key);
  if (hit && now - hit.at < ttlMs) return hit.val as Promise<T>;
  const val = fn();
  store.set(key, { at: now, val });
  // never cache a rejection: drop it so the next call retries
  val.catch(() => {
    if (store.get(key)?.val === val) store.delete(key);
  });
  return val;
}

/** Forget a cached value so the next call recomputes it (after the underlying data changed). */
export function invalidate(key: string): void {
  store.delete(key);
}

// ---------------------------------------------------------------- stale-while-revalidate (BAC-67)

type StaleEntry = {
  /** When the stored value was computed (ms); absent until the first compute resolves. */
  at: number | null;
  value: unknown;
  /** The compute running now, shared by every caller that has to wait or asked for a refresh. */
  running: Promise<unknown> | null;
};
const staleStore = new Map<string, StaleEntry>();

/**
 * Stale-while-revalidate for slow aggregates (Loki statement queries): a value younger than
 * `freshMs` is returned as is; an older one, up to `maxStaleMs`, is returned at once while one
 * background refresh runs; with nothing stored (or only a value past `maxStaleMs`) the caller waits
 * for the compute, shared with any caller already waiting. A rejection is never stored: the
 * previous value stays and the next call tries again. Keys follow the `cached` rules: include the
 * org and every input that changes the answer. `now` is injectable for tests.
 */
export function cachedStale<T>(
  key: string,
  freshMs: number,
  maxStaleMs: number,
  fn: () => Promise<T>,
  now: () => number = Date.now,
): Promise<T> {
  const entry = staleStore.get(key) ?? { at: null, value: undefined, running: null };
  staleStore.set(key, entry);
  const age = entry.at === null ? Infinity : now() - entry.at;
  if (age < freshMs) return Promise.resolve(entry.value as T);
  const refresh = (): Promise<unknown> => {
    if (entry.running) return entry.running;
    const run = fn().then(
      (value) => {
        entry.value = value;
        entry.at = now();
        entry.running = null;
        return value;
      },
      (err: unknown) => {
        entry.running = null;
        if (entry.at === null && staleStore.get(key) === entry) staleStore.delete(key);
        throw err;
      },
    );
    entry.running = run;
    return run;
  };
  if (age < maxStaleMs) {
    // Served stale: the refresh runs on its own; its failure must not surface as unhandled.
    refresh().catch(() => {});
    return Promise.resolve(entry.value as T);
  }
  return refresh() as Promise<T>;
}

/** Forget a stale-while-revalidate value (the next call waits for a fresh compute). */
export function invalidateStale(key: string): void {
  staleStore.delete(key);
}
