/**
 * Last week for the fixture metrics (BAC-73, insights plan 06): writes a week-old copy of the
 * fixture stack's hop series into its VictoriaMetrics, so "vs last week" and the Trend card's
 * dashed line have something to compare with on a stack that started today.
 *
 * TEST USE ONLY: run it against a local fixture stack, never a VictoriaMetrics real users read.
 *
 * What it writes: for every `backwork_hop_*` series of the last hours (same name, same labels),
 * a counter that grows at the rate the series grows now, from `--back` before to `--ahead` after
 * the instant exactly 7 days ago, one sample per `--step`. Additive and old timestamps only:
 * nothing current is touched or deleted. `--latency-scale 0.5` writes last week's latencies at
 * half (bucket counts and `_sum` moved accordingly), to stage a regression for the compare
 * features; the default 1 is a plain copy.
 *
 *   bun qa/fixtures/backfill-last-week.ts [--vm http://localhost:8428] [--back 8h] [--ahead 3h]
 *       [--step 60s] [--latency-scale 1] [--source 2h] [--dry-run] [--force]
 *
 * Run it once per stack: a second run would interleave a second copy. It refuses when samples
 * already exist 7 days back, unless --force.
 */

/** One series as VictoriaMetrics' export API returns it (one JSON object per line). */
interface ExportedSeries {
  metric: Record<string, string>;
  values: number[];
  timestamps: number[];
}

interface Options {
  vm: string;
  backS: number;
  aheadS: number;
  stepS: number;
  sourceS: number;
  latencyScale: number;
  dryRun: boolean;
  force: boolean;
}

/** Seconds in a week: "last week" in the compare features is `offset 7d`. */
export const WEEK_SECONDS = 7 * 86400;
/** Lines per import request. */
export const IMPORT_BATCH_LINES = 20_000;
/** The fixture series this copies. */
export const SERIES_MATCH = '{__name__=~"backwork_hop_.*"}';

const UNIT_SECONDS: Readonly<Record<string, number>> = { s: 1, m: 60, h: 3600, d: 86400 };

export function durationSeconds(v: string): number {
  const m = /^(\d+)([smhd])$/.exec(v);
  if (!m) throw new Error(`not a duration (e.g. 90s, 15m, 8h, 1d): ${v}`);
  return Number(m[1]) * UNIT_SECONDS[m[2]];
}

function parseArgs(argv: readonly string[]): Options {
  const o: Options = { vm: "http://localhost:8428", backS: 8 * 3600, aheadS: 3 * 3600, stepS: 60, sourceS: 2 * 3600, latencyScale: 1, dryRun: false, force: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = (): string => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === "--vm") o.vm = next().replace(/\/$/, "");
    else if (a === "--back") o.backS = durationSeconds(next());
    else if (a === "--ahead") o.aheadS = durationSeconds(next());
    else if (a === "--step") o.stepS = durationSeconds(next());
    else if (a === "--source") o.sourceS = durationSeconds(next());
    else if (a === "--latency-scale") o.latencyScale = Number(next());
    else if (a === "--dry-run") o.dryRun = true;
    else if (a === "--force") o.force = true;
    else throw new Error(`unknown option ${a}`);
  }
  if (!(o.latencyScale > 0)) throw new Error("--latency-scale must be above 0");
  if (o.aheadS >= WEEK_SECONDS) throw new Error("--ahead must stay below 7d, so every timestamp is in the past");
  return o;
}

/** Growth of a counter from its first sample to its last, counting resets as new starts (like
 *  `increase()`). */
export function counterGrowth(values: readonly number[]): number {
  let total = 0;
  for (let i = 1; i < values.length; i++) {
    const d = values[i] - values[i - 1];
    total += d >= 0 ? d : values[i];
  }
  return total;
}

function labelKey(metric: Record<string, string>, drop: string): string {
  return Object.entries(metric)
    .filter(([k]) => k !== drop)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join(",");
}

function leOf(metric: Record<string, string>): number {
  return metric.le === "+Inf" ? Infinity : Number(metric.le);
}

/**
 * Cumulative bucket counts with every latency multiplied by `scale`: the count at bound `b` is the
 * old cumulative count at `b / scale`, interpolated linearly between bounds (from 0 at 0).
 */
export function scaleBuckets(bounds: readonly number[], cumulative: readonly number[], scale: number): number[] {
  const finite = bounds.map((b, i) => [b, cumulative[i]] as const).filter(([b]) => Number.isFinite(b));
  const total = cumulative[bounds.findIndex((b) => !Number.isFinite(b))] ?? cumulative[cumulative.length - 1] ?? 0;
  const cdf = (x: number): number => {
    let prevB = 0;
    let prevC = 0;
    for (const [b, c] of finite) {
      if (x <= b) return prevC + ((c - prevC) * (x - prevB)) / (b - prevB || 1);
      prevB = b;
      prevC = c;
    }
    return total;
  };
  return bounds.map((b) => (Number.isFinite(b) ? Math.min(total, cdf(b / scale)) : total));
}

function promLabels(metric: Record<string, string>): string {
  const parts = Object.entries(metric)
    .filter(([k]) => k !== "__name__")
    .map(([k, v]) => `${k}="${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`);
  return parts.length ? `{${parts.join(",")}}` : "";
}

async function exportSeries(o: Options, startS: number, endS: number): Promise<ExportedSeries[]> {
  const body = new URLSearchParams({ "match[]": SERIES_MATCH, start: String(startS), end: String(endS) });
  const res = await fetch(`${o.vm}/api/v1/export`, { method: "POST", body });
  if (!res.ok) throw new Error(`export answered ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const text = await res.text();
  return text
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as ExportedSeries);
}

/** Per-second growth of every series over the source window, keyed by its exposition labels. */
function ratesOf(series: readonly ExportedSeries[], scale: number): Array<{ metric: Record<string, string>; perSecond: number }> {
  const growth = (s: ExportedSeries): number => {
    const ts = s.timestamps;
    const span = ts.length > 1 ? (ts[ts.length - 1] - ts[0]) / 1000 : 0;
    return span > 0 ? counterGrowth(s.values) / span : 0;
  };
  const out: Array<{ metric: Record<string, string>; perSecond: number }> = [];
  const buckets = new Map<string, ExportedSeries[]>();
  for (const s of series) {
    const name = s.metric.__name__ ?? "";
    if (name.endsWith("_bucket") && s.metric.le !== undefined) {
      const k = labelKey(s.metric, "le");
      buckets.set(k, [...(buckets.get(k) ?? []), s]);
      continue;
    }
    // durations and store time move with the latency scale; counts do not
    const scaled = name.endsWith("_sum") || name === "backwork_hop_store_seconds_total";
    out.push({ metric: s.metric, perSecond: growth(s) * (scaled ? scale : 1) });
  }
  for (const group of buckets.values()) {
    const sorted = [...group].sort((a, b) => leOf(a.metric) - leOf(b.metric));
    const bounds = sorted.map((s) => leOf(s.metric));
    // cumulative counts must not fall with the bound (they can by a sample at the edges)
    let max = 0;
    const cum = sorted.map((s) => (max = Math.max(max, growth(s))));
    const scaledCum = scale === 1 ? cum : scaleBuckets(bounds, cum, scale);
    sorted.forEach((s, i) => out.push({ metric: s.metric, perSecond: scaledCum[i] }));
  }
  return out;
}

async function alreadyThere(o: Options, fromS: number, toS: number): Promise<number> {
  const rows = await exportSeries(o, fromS, toS);
  return rows.reduce((n, r) => n + r.values.length, 0);
}

async function main(): Promise<void> {
  const o = parseArgs(process.argv.slice(2));
  const nowS = Math.floor(Date.now() / 1000);
  const anchorS = Math.floor((nowS - WEEK_SECONDS) / o.stepS) * o.stepS;
  const fromS = anchorS - o.backS;
  const toS = anchorS + o.aheadS;

  const existing = await alreadyThere(o, fromS, toS);
  if (existing > 0 && !o.force) {
    console.error(`${existing} samples already exist between ${new Date(fromS * 1000).toISOString()} and ${new Date(toS * 1000).toISOString()}: not writing a second copy (--force to write anyway)`);
    process.exit(1);
  }

  const source = await exportSeries(o, nowS - o.sourceS, nowS);
  if (!source.length) throw new Error(`no ${SERIES_MATCH} series in the last ${o.sourceS} s: is the fixture stack running?`);
  const rates = ratesOf(source, o.latencyScale).filter((r) => r.perSecond > 0);
  const steps = Math.floor((toS - fromS) / o.stepS) + 1;
  console.log(
    `${rates.length} series, ${steps} samples each, ${new Date(fromS * 1000).toISOString()} to ${new Date(toS * 1000).toISOString()}` +
      ` (latency scale ${o.latencyScale}${o.dryRun ? ", dry run" : ""})`,
  );

  let batch: string[] = [];
  let sent = 0;
  const flush = async (): Promise<void> => {
    if (!batch.length) return;
    if (!o.dryRun) {
      const res = await fetch(`${o.vm}/api/v1/import/prometheus`, { method: "POST", body: batch.join("\n") + "\n" });
      if (!res.ok) throw new Error(`import answered ${res.status}: ${(await res.text()).slice(0, 200)}`);
    }
    sent += batch.length;
    batch = [];
  };
  for (const r of rates) {
    const head = `${r.metric.__name__}${promLabels(r.metric)}`;
    for (let i = 0; i < steps; i++) {
      const tS = fromS + i * o.stepS;
      const v = r.perSecond * (tS - fromS);
      batch.push(`${head} ${Number(v.toFixed(6))} ${tS * 1000}`);
      if (batch.length >= IMPORT_BATCH_LINES) await flush();
    }
  }
  await flush();
  console.log(`${o.dryRun ? "would write" : "wrote"} ${sent} samples; compare windows now have last week until ${new Date((toS + WEEK_SECONDS) * 1000).toISOString()}`);
}

if (import.meta.main) {
  main().catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
}
