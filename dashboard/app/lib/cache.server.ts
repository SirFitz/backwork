// Tiny in-process TTL cache with request coalescing. Expensive aggregations
// (serviceHealth, APM, label lists) are shared across panels and across the
// 10s auto-refresh instead of recomputed on every loader call. Caching the
// in-flight promise means concurrent callers (e.g. Overview asking for health
// directly AND via getIncidents) collapse into ONE backend round-trip.
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
