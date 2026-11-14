// Counting what happened in a window from the hop counters (pure query builders).
//
// The collector writes a counter only while records arrive: a burst of samples, then silence
// for as long as the service is idle (an hourly job leaves an hour between bursts). PromQL's
// `increase(x[w])` needs a sample before the window to know where the counter stood; with the
// last one outside the window, VictoriaMetrics guesses from the first sample inside it, and an
// hourly job's 90 calls read as 110 over one hour (or 77, depending on the series).
//
// So a window is read as the difference of two increases that start at the same instant, a
// lookback before the window: increase over [start - lookback, end] minus increase over
// [start - lookback, start]. Both see the same first sample, so whatever is guessed about it
// cancels, and counter resets are still handled by `increase()`. A group with no samples before
// the window keeps the first term alone (nothing to subtract). Exact for any gap shorter than
// the lookback.

/** How far before a window to look for the counter's last value. VictoriaMetrics keeps 14 days. */
export const COUNTER_LOOKBACK_SECONDS = 7 * 86400;

const DURATION_UNIT_SECONDS: Readonly<Record<string, number>> = { s: 1, m: 60, h: 3600, d: 86400, w: 604800 };

/** Seconds in a PromQL duration such as `15m`, `6h` or `7d`. */
export function windowSeconds(window: string): number {
  const m = /^(\d+)([smhdw])$/.exec(window);
  if (!m) throw new Error(`not a PromQL duration: ${window}`);
  return Number(m[1]) * DURATION_UNIT_SECONDS[m[2]];
}

function byClause(labels: readonly string[]): string {
  return labels.length ? `by (${labels.join(", ")}) ` : "";
}

/**
 * How much `selector` grew in the window that ends `offset` before now, summed by `labels`,
 * never below zero. `selector` is a full series selector, e.g. `m{dir="in"}`. `lookbackSeconds`
 * is shortened for a window far in the past (BAC-67: last week's figures), so that
 * `offset + window + lookback` stays inside VictoriaMetrics' 14-day retention.
 */
export function windowIncrease(
  selector: string,
  window: string,
  labels: readonly string[],
  offset: string | null = null,
  lookbackSeconds: number = COUNTER_LOOKBACK_SECONDS,
): string {
  const w = windowSeconds(window);
  const off = offset ? windowSeconds(offset) : 0;
  const lb = lookbackSeconds;
  const at = (seconds: number): string => (seconds > 0 ? ` offset ${seconds}s` : "");
  const sum = `sum ${byClause(labels)}`;
  const whole = `${sum}(increase(${selector}[${w + lb}s]${at(off)}))`;
  const before = `${sum}(increase(${selector}[${lb}s]${at(off + w)}))`;
  return `clamp_min((${whole} - ${before}) or ${whole}, 0)`;
}

/** Per second over the window: the window's increase divided by its length. */
export function windowPerSecond(
  selector: string,
  window: string,
  labels: readonly string[],
  offset: string | null = null,
  lookbackSeconds: number = COUNTER_LOOKBACK_SECONDS,
): string {
  return `${windowIncrease(selector, window, labels, offset, lookbackSeconds)} / ${windowSeconds(window)}`;
}
