/**
 * Slow queries board (BAC-69): the LogQL that sums database calls by statement over a window, and
 * the merge of the raw Loki groups into one row per statement shape. Pure: no Loki, Remix or
 * database imports, so it is tested with plain objects and can run in the browser.
 *
 * Statement text is not a metric label, so the figures come from on-demand LogQL metric queries
 * over the stored `out_end` `via=db` hop records (README "Slow queries source"). Records arrive in
 * two families of formats, each with its own query:
 * - JSON: a JSON record, either at the top level or one level under `metadata`, `fields`, `data`,
 *   `context` or `attributes` (as `parse.ts` reads it);
 * - key=value: `stmt=` always comes last and runs to the end of the line, so it is cut off first and
 *   every other field is read from the head with an anchored regexp (`(?:^|\s)op=` never matches
 *   `hop=in_end`).
 * Either may be wrapped in the collector's JSON envelope, whose `message` holds the record.
 */
import { shapeId, statementShape } from "./stmt-shape";

/** The windows the board offers. 24 hours waits for a measurement on the reference deployment. */
export const SlowWindow = { H1: "1h", H6: "6h" } as const;
export type SlowWindow = (typeof SlowWindow)[keyof typeof SlowWindow];

export const SLOW_WINDOWS: readonly SlowWindow[] = Object.values(SlowWindow);

/** Length of each window in milliseconds. */
export const SLOW_WINDOW_MS: Record<SlowWindow, number> = {
  [SlowWindow.H1]: 3_600_000,
  [SlowWindow.H6]: 6 * 3_600_000,
};

export function isSlowWindow(v: unknown): v is SlowWindow {
  return typeof v === "string" && (SLOW_WINDOWS as readonly string[]).includes(v);
}

/** The record formats, one LogQL query each. */
export const RecordFormat = { Json: "json", Kv: "kv" } as const;
export type RecordFormat = (typeof RecordFormat)[keyof typeof RecordFormat];

export const RECORD_FORMATS: readonly RecordFormat[] = Object.values(RecordFormat);

/** What a query measures per statement group. */
export const SlowMeasure = { Calls: "calls", Total: "total", P95: "p95" } as const;
export type SlowMeasure = (typeof SlowMeasure)[keyof typeof SlowMeasure];

export const SLOW_MEASURES: readonly SlowMeasure[] = Object.values(SlowMeasure);

/** Raw statement groups each query returns at most (`topk`): Loki refuses more than 5000 series,
 *  and the board shows the groups that took the most time. */
export const SLOW_GROUP_LIMIT = 200;

/** The labels every statement query groups by. */
export const SLOW_GROUP_LABELS = ["service", "peer", "table", "stmt"] as const;
export type SlowGroupLabel = (typeof SLOW_GROUP_LABELS)[number];

/** Containers a JSON record may nest its fields in (one level, first wins; `parse.ts`). */
const NESTED_CONTAINERS = ["metadata", "fields", "data", "context", "attributes"] as const;
/** Record fields the queries read. */
const RECORD_FIELDS = ["hop", "via", "stmt", "table", "peer", "duration_us"] as const;

/** A LogQL double-quoted string (Go escapes, which JSON's are a subset of). */
export function logqlString(raw: string): string {
  return JSON.stringify(raw);
}

/** The stream selector: every hop stream, or one service's. */
export function hopSelector(service?: string): string {
  return service === undefined ? `{kind="hop"}` : `{kind="hop", service=${logqlString(service)}}`;
}

/** Line filters and the envelope unwrap shared by both formats: afterwards the line is the record. */
function recordPrelude(service?: string): string {
  // The envelope's `message` is the record when it names a trace; otherwise (a bare record, or a
  // nested JSON record whose own `message` is "hop") the whole line is the record.
  const unwrap = "{{ if contains \"trace_id\" .rec }}{{ .rec }}{{ else }}{{ __line__ }}{{ end }}";
  return [
    hopSelector(service),
    `|= "out_end"`,
    `|~ ${logqlString("via\\W{1,6}db")}`,
    `| json rec="message"`,
    `| drop __error__, __error_details__`,
    `| line_format ${logqlString(unwrap)}`,
  ].join(" ");
}

const KEEP = `| keep ${SLOW_GROUP_LABELS.join(", ")}, duration_us`;
const RECORD_FILTERS = `| hop="out_end" | via="db" | stmt!=""`;

/** JSON records: top-level fields, or the first nested container that has them. */
function jsonPipeline(service?: string): string {
  const coalesce = RECORD_FIELDS.map((f) => {
    const sources = [f, ...NESTED_CONTAINERS.map((c) => `${c}_${f}`)].map((s) => `.${s}`).join(" ");
    return `${f}=${logqlString(`{{ or ${sources} }}`)}`;
  }).join(", ");
  return `${recordPrelude(service)} | json | __error__="" | label_format ${coalesce} ${RECORD_FILTERS} ${KEEP}`;
}

/** Anchored regexp for one key=value field of the record head (the head ends in a space). */
export function kvFieldRegexp(field: string): string {
  return `(?:^|\\s)${field}=(?P<${field}>\\S+)\\s`;
}

/** The head/statement split of a key=value record: `stmt=` is always the last field. */
export const KV_STMT_REGEXP = "^(?P<kv_head>.*?)\\sstmt=(?P<stmt>.*)$";

/** key=value records (bare or in the envelope), never a JSON line. */
function kvPipeline(service?: string): string {
  const fields = RECORD_FIELDS.filter((f) => f !== "stmt")
    .map((f) => `| regexp ${logqlString(kvFieldRegexp(f))}`)
    .join(" ");
  return [
    recordPrelude(service),
    `!~ ${logqlString("^\\s*\\{")}`,
    `| regexp ${logqlString(KV_STMT_REGEXP)}`,
    `| line_format ${logqlString("{{ .kv_head }} ")}`,
    fields,
    RECORD_FILTERS,
    KEEP,
  ].join(" ");
}

/** The parsing pipeline of one record format (no range, no aggregation). */
export function statementPipeline(format: RecordFormat, service?: string): string {
  return format === RecordFormat.Json ? jsonPipeline(service) : kvPipeline(service);
}

const BY = `by (${SLOW_GROUP_LABELS.join(", ")})`;

/** One measure per statement group, before `topk`. Calls: count; total and p95: microseconds. */
function measureQuery(format: RecordFormat, measure: SlowMeasure, window: SlowWindow, service?: string): string {
  const pipe = statementPipeline(format, service);
  const range = `[${window}]`;
  const unwrapped = `${pipe} | unwrap duration_us | __error__="" ${range}`;
  switch (measure) {
    case SlowMeasure.Calls:
      return `sum ${BY} (count_over_time(${pipe} ${range}))`;
    case SlowMeasure.Total:
      return `sum ${BY} (sum_over_time(${unwrapped}))`;
    case SlowMeasure.P95:
      return `quantile_over_time(0.95, ${unwrapped}) ${BY}`;
  }
}

/**
 * The LogQL for one measure and format: the `SLOW_GROUP_LIMIT` largest groups. With
 * `restrictToTopTotal` the result is limited to the groups of the total-time list instead (used
 * when the lists were cut, so every row has all three measures).
 */
export function slowQueryLogql(
  format: RecordFormat,
  measure: SlowMeasure,
  window: SlowWindow,
  service?: string,
  restrictToTopTotal: boolean = false,
): string {
  const top = (q: string): string => `topk(${SLOW_GROUP_LIMIT}, ${q})`;
  const own = measureQuery(format, measure, window, service);
  if (!restrictToTopTotal || measure === SlowMeasure.Total) return top(own);
  return `${own} and ${top(measureQuery(format, SlowMeasure.Total, window, service))}`;
}

// ---------------------------------------------------------------- merge

/** One raw statement group as Loki returned it, with whichever measures came back. */
export interface RawStatementGroup {
  service: string;
  peer: string | null;
  table: string | null;
  stmt: string;
  calls: number | null;
  /** Microseconds spent in the group over the window. */
  totalUs: number | null;
  /** 95th percentile of one call, microseconds. */
  p95Us: number | null;
}

/** One series of a metric query (labels and value), as `loki.metricInstant` returns it. */
export interface MeasureSample {
  metric: Readonly<Record<string, string>>;
  value: number;
}

/** Every format's samples for one measure. */
export type MeasureSamples = Readonly<Record<SlowMeasure, readonly MeasureSample[]>>;

function groupKey(m: Readonly<Record<string, string>>): string | null {
  const stmt = m.stmt;
  if (!stmt) return null;
  return [m.service ?? "", m.peer ?? "", m.table ?? "", stmt].join("\0");
}

/** Join the three measures' samples into raw groups (one per service, peer, table, statement). */
export function rawGroups(samples: MeasureSamples): RawStatementGroup[] {
  const groups = new Map<string, RawStatementGroup>();
  const field: Record<SlowMeasure, "calls" | "totalUs" | "p95Us"> = {
    [SlowMeasure.Calls]: "calls",
    [SlowMeasure.Total]: "totalUs",
    [SlowMeasure.P95]: "p95Us",
  };
  for (const measure of SLOW_MEASURES) {
    for (const s of samples[measure]) {
      const key = groupKey(s.metric);
      if (key === null || !Number.isFinite(s.value)) continue;
      let g = groups.get(key);
      if (!g) {
        g = {
          service: s.metric.service || "unknown",
          peer: s.metric.peer || null,
          table: s.metric.table || null,
          stmt: s.metric.stmt,
          calls: null,
          totalUs: null,
          p95Us: null,
        };
        groups.set(key, g);
      }
      // The same group from two formats (one service writing both) adds up; p95 keeps the larger.
      const k = field[measure];
      const prev = g[k];
      g[k] = prev === null ? s.value : k === "p95Us" ? Math.max(prev, s.value) : prev + s.value;
    }
  }
  return [...groups.values()];
}

/** One statement shape on the board. */
export interface QueryRow {
  /** `shapeId(shape)`, for URLs. */
  shapeId: string;
  /** `statementShape(stmt)`. */
  shape: string;
  /** One raw statement text (the slowest group's), for display and the routes lookup. */
  sample: string;
  service: string;
  peer: string | null;
  table: string | null;
  calls: number;
  /** Seconds spent in it over the window. */
  totalS: number;
  /** Call-weighted mean of the merged groups' p95 in seconds (approximate when merged). */
  p95S: number | null;
  /** More than one raw group merged into this row, so `p95S` is an estimate. */
  p95Approx: boolean;
  /** `totalS` over the total of every row of the same service (0..1). */
  shareOfDb: number;
}

/**
 * Merge raw groups into one row per (service, shape): raw statements that differ only by values,
 * lists or case become one row. Calls and totals add; p95 is the call-weighted mean of the groups'
 * p95, flagged approximate when more than one group merged. Groups without a total (cut from the
 * total-time list) are left out. Rows come back by total time, largest first.
 */
export function mergeByShape(groups: readonly RawStatementGroup[]): QueryRow[] {
  interface Acc {
    row: QueryRow;
    parts: number;
    p95Weighted: number;
    p95Calls: number;
    sampleUs: number;
  }
  const byKey = new Map<string, Acc>();
  for (const g of groups) {
    if (g.totalUs === null) continue;
    const shape = statementShape(g.stmt);
    const key = `${g.service}\0${shape}`;
    const calls = g.calls ?? 0;
    let acc = byKey.get(key);
    if (!acc) {
      acc = {
        row: {
          shapeId: shapeId(shape),
          shape,
          sample: g.stmt,
          service: g.service,
          peer: g.peer,
          table: g.table,
          calls: 0,
          totalS: 0,
          p95S: null,
          p95Approx: false,
          shareOfDb: 0,
        },
        parts: 0,
        p95Weighted: 0,
        p95Calls: 0,
        sampleUs: -1,
      };
      byKey.set(key, acc);
    }
    acc.parts += 1;
    acc.row.calls += calls;
    acc.row.totalS += g.totalUs / 1e6;
    if (g.p95Us !== null) {
      const weight = calls > 0 ? calls : 1;
      acc.p95Weighted += (g.p95Us / 1e6) * weight;
      acc.p95Calls += weight;
    }
    if (g.totalUs > acc.sampleUs) {
      acc.sampleUs = g.totalUs;
      acc.row.sample = g.stmt;
    }
    if (acc.row.peer !== g.peer) acc.row.peer = acc.row.peer ?? g.peer;
    if (acc.row.table !== g.table) acc.row.table = acc.row.table ?? g.table;
  }
  const rows: QueryRow[] = [];
  const serviceTotal = new Map<string, number>();
  for (const acc of byKey.values()) {
    acc.row.p95S = acc.p95Calls > 0 ? acc.p95Weighted / acc.p95Calls : null;
    acc.row.p95Approx = acc.parts > 1 && acc.row.p95S !== null;
    rows.push(acc.row);
    serviceTotal.set(acc.row.service, (serviceTotal.get(acc.row.service) ?? 0) + acc.row.totalS);
  }
  for (const r of rows) {
    const total = serviceTotal.get(r.service) ?? 0;
    r.shareOfDb = total > 0 ? r.totalS / total : 0;
  }
  return sortQueryRows(rows, QuerySort.Total);
}

/** How the board orders its rows. */
export const QuerySort = { Total: "total", P95: "p95", Calls: "calls" } as const;
export type QuerySort = (typeof QuerySort)[keyof typeof QuerySort];

export const QUERY_SORTS: readonly QuerySort[] = Object.values(QuerySort);

export const QUERY_SORT_LABEL: Record<QuerySort, string> = {
  [QuerySort.Total]: "Total time",
  [QuerySort.P95]: "p95",
  [QuerySort.Calls]: "Calls",
};

export function isQuerySort(v: unknown): v is QuerySort {
  return typeof v === "string" && (QUERY_SORTS as readonly string[]).includes(v);
}

/** Rows ordered by `sort`, largest first; ties by total time, then shape. Returns a new array. */
export function sortQueryRows(rows: readonly QueryRow[], sort: QuerySort): QueryRow[] {
  const value = (r: QueryRow): number =>
    sort === QuerySort.Calls ? r.calls : sort === QuerySort.P95 ? (r.p95S ?? -1) : r.totalS;
  return [...rows].sort((a, b) => value(b) - value(a) || b.totalS - a.totalS || a.shape.localeCompare(b.shape));
}

// ---------------------------------------------------------------- routes that call a statement

/** Database calls sampled per row when looking up the routes that call it. */
export const ROUTE_SAMPLE_LIMIT = 200;
/** Parent hop ids per inbound lookup query (an alternation on `hop_id`). */
export const ROUTE_PARENT_BATCH = 50;

/** One sampled database call: who made it and how long it took. */
export interface SampledCall {
  traceId: string;
  parentHop: string | null;
  durationUs: number | null;
}

/** One inbound hop end (a route served). */
export interface InboundEnd {
  hopId: string;
  service: string;
  method: string | null;
  op: string | null;
}

/** A route that runs the statement, with how many sampled calls came from it. */
export interface CallingRoute {
  service: string;
  method: string | null;
  op: string | null;
  calls: number;
}

export interface StatementRoutes {
  routes: CallingRoute[];
  /** The slowest sampled call's trace, for "Open a slow example". */
  exampleTraceId: string | null;
  /** Database calls the routes were counted from. */
  sampled: number;
}

/** Hop ids in batches of `size`, duplicates and invalid ids dropped. */
export function parentBatches(calls: readonly SampledCall[], size: number = ROUTE_PARENT_BATCH): string[][] {
  const ids = [...new Set(calls.map((c) => c.parentHop).filter((id): id is string => id !== null && /^[0-9a-f]{16}$/.test(id)))];
  const out: string[][] = [];
  for (let i = 0; i < ids.length; i += size) out.push(ids.slice(i, i + size));
  return out;
}

/** The line filter that finds the inbound end records of a batch of hop ids. */
export function inboundEndLogql(hopIds: readonly string[]): string {
  return `{kind="hop"} |= "in_end" |~ ${logqlString(`(${hopIds.join("|")})`)}`;
}

/** Line filter pieces of a statement: at most this many. */
export const STATEMENT_NEEDLES_MAX = 6;

/**
 * The runs of the statement without quotes or backslashes (the longest few, at least 4 characters,
 * or the longest one): line filters for them match the statement whether the record is stored bare
 * or JSON-escaped inside the envelope. Candidate lines are then parsed and compared exactly.
 */
export function statementNeedles(sample: string): string[] {
  const parts = [...new Set(sample.split(/["\\]/))].sort((a, b) => b.length - a.length);
  const long = parts.filter((p) => p.length >= 4).slice(0, STATEMENT_NEEDLES_MAX);
  return long.length > 0 ? long : parts.slice(0, 1).filter((p) => p.length > 0);
}

/** The line filters that find database calls of one raw statement text. */
export function statementCallsLogql(sample: string, service: string): string {
  const needles = statementNeedles(sample).map((n) => ` |= ${logqlString(n)}`).join("");
  return `${hopSelector(service)} |= "out_end"${needles}`;
}

/** Group sampled calls by the inbound route that made them; unknown parents are skipped. */
export function groupCallingRoutes(calls: readonly SampledCall[], inbound: readonly InboundEnd[]): StatementRoutes {
  const byHop = new Map(inbound.map((i) => [i.hopId, i]));
  const routes = new Map<string, CallingRoute>();
  for (const c of calls) {
    const parent = c.parentHop === null ? undefined : byHop.get(c.parentHop);
    if (!parent) continue;
    const key = `${parent.service}\0${parent.method ?? ""}\0${parent.op ?? ""}`;
    const r = routes.get(key) ?? { service: parent.service, method: parent.method, op: parent.op, calls: 0 };
    r.calls += 1;
    routes.set(key, r);
  }
  let slowest: SampledCall | null = null;
  for (const c of calls) {
    if (c.durationUs === null) continue;
    if (!slowest || (slowest.durationUs ?? -1) < c.durationUs) slowest = c;
  }
  return {
    routes: [...routes.values()].sort((a, b) => b.calls - a.calls || (a.op ?? "").localeCompare(b.op ?? "")),
    exampleTraceId: slowest?.traceId ?? null,
    sampled: calls.length,
  };
}
