/**
 * Durations and counts in words, shared by the request view and the pure analysis modules that
 * build sentences ("select plans ran 14 times, 62.0 ms in all"). BAC-67 foundation. Pure.
 */

/** Microseconds as the frames show them: 0.4 ms, 61.2 ms, 412 ms, 30.02 s, 4 m 12 s. */
export function fmtUs(us: number): string {
  const ms = us / 1000;
  if (ms < 0.1) return `${ms.toFixed(2)} ms`;
  if (ms < 100) return `${ms.toFixed(1)} ms`;
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(2)} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} m ${Math.floor(s - m * 60)} s`;
  const h = Math.floor(m / 60);
  return `${h} h ${m - h * 60} m`;
}

/** A count with its noun: "1 call", "14 calls". */
export function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}
