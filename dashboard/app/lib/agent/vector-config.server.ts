/**
 * The Vector configuration for both collectors: the stack's own collector
 * (`infra/vector/vector.yaml`, generated from this module by
 * `infra/vector/generate.ts`) and the backwork agent written by
 * `/install.sh`. One source so the two can never drift (a test checks the
 * checked-in file equals `stackConfigYaml()`).
 *
 * Pipeline (design 4, 5, 19):
 *   source(s) -> bw_join_route -> bw_join_lines -> bw_join_blocks -> bw_join_tidy (BAC-94) -> bw_normalize -> bw_detect -> bw_controls -> loki
 *                                                 \-> bw_metric_prep -> bw_hop_route
 *                                                       -> bw_hop_duration / bw_hop_started / bw_hop_store
 *                                                          (+ bw_hop_store_cache_hit / _cache_miss / _db_wait, BAC-79)
 *                                                       -> bw_hop_cardinality -> prometheus (stack) | remote write (agent)
 *
 * bw_join_*     BAC-94: a multi-line entry (error header, stack, template excerpt, dump) is one
 *               event again, by the rules in lib/log-join.ts. JSON lines and hop records skip it.
 * bw_detect     design 5.1/5.2: `kind` label, parsed hop fields kept in event
 *               metadata (%bw_hop), the line itself untouched.
 * bw_controls   design 19: switches (drop a kind, strip named fields / store
 *               totals) and the sensitive-data filter. Generated per project
 *               for agents from the dashboard's switches (controlsVrl).
 * metrics       design 5.3.
 *
 * Every VRL program here is inlined into YAML, where Vector expands `$VAR`,
 * so every `$` is written `$$` (see `inlineVrl`).
 */
import {
  BUILT_IN_PATTERNS,
  COLLECTOR_FEATURES,
  type ControlsSnapshot,
  type CollectorFeature,
} from "~/lib/controls.server";
import { lineMatchSource, pathMatchSource } from "~/lib/excluded-paths";
import { STORE_TOTAL_FIELDS, STORE_TOTALS_KV_PATTERN, StoreSeries } from "~/lib/hops/store-fields";
import {
  CONTINUATION_PATTERN,
  ERROR_HEADER_PATTERN,
  JOIN_MAX_CHARS,
  JOIN_MAX_LINES,
  JOIN_TIMEOUT_MS,
  SOLO_PATTERN,
} from "~/lib/log-join";

/** Histogram buckets in seconds, design 5.3. */
export const HOP_BUCKETS: readonly number[] = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 300, 900];

/** Distinct values per label per collector, design 5.3. */
export const LABEL_VALUE_LIMIT = 2000;

export const MetricName = {
  Duration: "backwork_hop_duration_seconds",
  Started: "backwork_hop_started_total",
  StoreSeconds: "backwork_hop_store_seconds_total",
  StoreCalls: "backwork_hop_store_calls_total",
} as const;
export type MetricName = (typeof MetricName)[keyof typeof MetricName];

/** Containers a structured logger may nest fields under, design 5.1. */
export const NESTED_KEYS: readonly string[] = ["metadata", "fields", "data", "context", "attributes"];

// ---------------------------------------------------------------------------
// VRL programs
// ---------------------------------------------------------------------------

export const CollectorKind = { Stack: "stack", Agent: "agent" } as const;
export type CollectorKind = (typeof CollectorKind)[keyof typeof CollectorKind];

/** Service name, level and display text. The stack and agent differ only in `host`. */
export function normalizeVrl(kind: CollectorKind): string {
  const host = kind === CollectorKind.Agent ? `.host = "__NAME__"\n` : "";
  return `${serviceVrl(host)}
${LEVEL_VRL}`;
}

/** Service, source, project and role from the container labels or the PM2 file name. */
function serviceVrl(host: string): string {
  return `labels = object(.label) ?? {}

# Service name (design 5.2): Coolify resource name > compose service >
# container name; for PM2 log files the PM2 process name from the file name
# (<name>-out.log, <name>-error.log, <name>-out-<n>.log).
svc = get(labels, ["coolify.resourceName"]) ?? null
if svc == null { svc = get(labels, ["com.docker.compose.service"]) ?? null }
if svc == null && exists(.file) {
  fname = to_string(.file) ?? ""
  m = parse_regex(fname, r'(?P<name>[^/]+?)-(?:out|error|err)(?:-\\d+)?\\.log$') ?? {}
  svc = get(m, ["name"]) ?? null
}
if svc == null { svc = .container_name }
.service = to_string(svc) ?? ""
if .service == "" { .service = "unknown" }
# Where the line came from. Ordinary lines keep it as their service; a hop record's service
# becomes the record's own field (bw_detect), and source joins the two (BAC-49).
.source = .service
.project = to_string(get(labels, ["coolify.projectName"]) ?? "") ?? ""
.role = to_string(get(labels, ["com.docker.compose.service"]) ?? "") ?? ""
${host}`;
}

/** Level and display text from the line itself; shared by every collector input. */
export const LEVEL_VRL = `# Structured JSON logs: lift level/msg.
.level = "info"
parsed = parse_json(.message) ?? {}
lvl = get(parsed, ["level"]) ?? get(parsed, ["lvl"]) ?? get(parsed, ["severity"]) ?? null
if lvl != null {
  # pino/bunyan use numeric levels (10=trace..60=fatal); map them.
  ln = to_int(lvl) ?? -1
  if ln >= 60 { .level = "fatal" } else if ln >= 50 { .level = "error" } else if ln >= 40 { .level = "warn" } else if ln >= 30 { .level = "info" } else if ln >= 20 { .level = "debug" } else if ln >= 10 { .level = "trace" } else { .level = downcase(to_string(lvl) ?? "info") }
}
msg = get(parsed, ["msg"]) ?? get(parsed, ["message"]) ?? null
if msg != null { .display = to_string(msg) ?? .message }
if !exists(.display) { .display = .message }

# Heuristic level for unstructured lines (proxies, runtimes, DBs, Elixir console). A joined
# multi-line entry (bw_join) is read by its first line, so words in its stack or dump do not count.
if .level == "info" {
  bw_lines = split(to_string(.message) ?? "", "\\n", limit: 2)
  m = downcase(to_string(bw_lines[0]))
  if contains(m, "level=error") || contains(m, "\\"error\\"") || contains(m, "[error]") || contains(m, "panic") || contains(m, "fatal") || contains(m, "exception") {
    .level = "error"
  } else if contains(m, "level=warn") || contains(m, "[warn]") || contains(m, "[warning]") || contains(m, "warning") || contains(m, "deprecat") {
    .level = "warn"
  } else if contains(m, "level=debug") || contains(m, "[debug]") {
    .level = "debug"
  }
}
if .level == "warning" { .level = "warn" }
if .level == "err" || .level == "critical" || .level == "crit" { .level = "error" }
`;

/** Design 5.1 / 5.2. Adds `.kind`; keeps parsed fields in metadata; never alters the line. */
export const DETECT_VRL = `# Hop record and link line detection (design 5.1). Never drops or alters the line.
.kind = "log"
bw_raw = to_string(.message) ?? ""
bw_src = {}
bw_fmt = ""
bw_box = ""
bw_json = parse_json(bw_raw) ?? null
if is_object(bw_json) {
  bw_o = object(bw_json) ?? {}
  bw_fmt = "json"
  if (get(bw_o, ["trace_id"]) ?? null) != null {
    bw_src = bw_o
  } else {
    for_each(${JSON.stringify(NESTED_KEYS)}) -> |_i, k| {
      if bw_box == "" {
        c = object(get(bw_o, [k]) ?? null) ?? {}
        if (get(c, ["trace_id"]) ?? null) != null {
          bw_src = c
          bw_box = k
        }
      }
    }
  }
} else if contains(bw_raw, "trace_id=") {
  bw_fmt = "kv"
  # stmt is the last pair and runs to the end of the line, spaces included (spec HOP-14, 13.2):
  # split it off first, so text inside it never becomes a field.
  bw_kvp = parse_regex(bw_raw, r'^(?P<head>.*?)(?: stmt=(?P<stmt>.*))?$') ?? {}
  bw_kvh = to_string(get(bw_kvp, ["head"]) ?? bw_raw) ?? bw_raw
  # A host's log format may print trace_id (and more) in front of the message too: read the
  # record's own pairs, from the first "trace_id=<32 hex> hop=" on, when the line has them.
  bw_rec = parse_regex(bw_kvh, r'(?P<rec>trace_id=[0-9a-f]{32} hop=.*)$') ?? {}
  # get() of a missing key is null, not an error: a line without such a run (a link line) keeps its head.
  bw_recs = to_string(get(bw_rec, ["rec"]) ?? "") ?? ""
  if bw_recs != "" { bw_kvh = bw_recs }
  bw_src = parse_key_value(bw_kvh, key_value_delimiter: "=", field_delimiter: " ") ?? {}
  # A key repeated with equal values is read once; differing values stay a list (not a record).
  bw_src = map_values(bw_src) -> |v| {
    if is_array(v) {
      bw_u = unique(array!(v))
      if length(bw_u) == 1 { bw_u[0] } else { v }
    } else { v }
  }
  bw_kvs = get(bw_kvp, ["stmt"]) ?? null
  if bw_kvs != null { bw_src = set(bw_src, ["stmt"], bw_kvs) ?? bw_src }
}
bw_tid = to_string(get(bw_src, ["trace_id"]) ?? "") ?? ""
if match(bw_tid, r'^[0-9a-f]{32}$') {
  bw_hk = to_string(get(bw_src, ["hop"]) ?? "") ?? ""
  bw_hid = to_string(get(bw_src, ["hop_id"]) ?? "") ?? ""
  if includes(["in", "in_end", "out", "out_end"], bw_hk) && match(bw_hid, r'^[0-9a-f]{16}$') {
    .kind = "hop"
    %bw_type = "hop"
  } else if (get(bw_src, ["link_name"]) ?? null) != null && (get(bw_src, ["link_value"]) ?? null) != null {
    .kind = "hop"
    %bw_type = "link"
  }
}
if .kind == "hop" {
  %bw_hop = bw_src
  %bw_fmt = bw_fmt
  %bw_box = bw_box
}
`;

/** VRL that leaves `bw_l` holding EXPR as a valid label value (HOP-12) or "". */
function labelVrl(target: string, expr: string): string {
  return `bw_l = to_string(${expr} ?? "") ?? ""
if !match(bw_l, r'^[\\x21-\\x7e]{1,200}$') { bw_l = "" }
bw_m.${target} = bw_l
`;
}

/** VRL that sets `bw_m.TARGET` to FIELD / DIVISOR only when the record carries FIELD as a number
 *  of at least 0 (proposed HOP-25, HOP-26). A service that does not report it gets no value, so
 *  its counter is never written and its figures read "no data", not 0. */
function optionalTotalVrl(target: string, field: string, divisor: number): string {
  const value = divisor === 1 ? "bw_x" : `bw_x / ${divisor.toFixed(1)}`;
  return `  bw_x = get(bw_h, [${vrlString(field)}]) ?? null
  if bw_x != null {
    bw_x = to_float(bw_x) ?? -1.0
    if bw_x >= 0.0 { bw_m.${target} = ${value} }
  }
`;
}

/** Design 5.3: the labels and values the metric transforms read, under `.bw_m`. TENANT (the
 *  records intake, BAC-96) adds the org_id and project the intake left in metadata, so the
 *  series are scoped as an agent's remote write is by the ingest proxy. */
export function metricPrepVrl(tenant: boolean): string {
  const scope = tenant
    ? `# Tenant labels, as the metrics ingest proxy stamps them on an agent's series.
bw_m.org_id = to_string(%bw_org) ?? ""
bw_m.project = to_string(%bw_project) ?? ""
`
    : "";
  return `# Hop metrics input (design 5.3). Only hop records reach the metrics.
if (to_string(%bw_type) ?? "") != "hop" || %bw_metrics == false { abort }
bw_h = object(%bw_hop) ?? {}
bw_hk = to_string(get(bw_h, ["hop"]) ?? "") ?? ""
bw_m = {}
${scope}bw_l = to_string(.service) ?? ""
if !match(bw_l, r'^[\\x21-\\x7e]{1,200}$') { bw_l = "" }
bw_m.service = bw_l
bw_m.dir = if starts_with(bw_hk, "in") { "in" } else { "out" }
${labelVrl("via", 'get(bw_h, ["via"])')}${labelVrl("method", 'get(bw_h, ["method"])')}${labelVrl("op", 'get(bw_h, ["op"])')}${labelVrl("peer", 'get(bw_h, ["peer"])')}${labelVrl("outcome", 'get(bw_h, ["outcome"])')}bw_st = to_int(get(bw_h, ["status"]) ?? 0) ?? 0
# HOP-28 (BAC-80): inbound hops of a monitor's request carry synthetic=1. "1" or "" (an empty
# label is no label, so series without it, and older collectors, stay one series as before).
bw_sy = get(bw_h, ["synthetic"]) ?? null
bw_m.synthetic = if bw_m.dir == "in" && (bw_sy == 1 || bw_sy == "1" || bw_sy == true || bw_sy == "true") { "1" } else { "" }
bw_m.status_class = if bw_st >= 200 && bw_st < 300 { "2xx" } else if bw_st >= 300 && bw_st < 400 { "3xx" } else if bw_st >= 400 && bw_st < 500 { "4xx" } else if bw_st >= 500 && bw_st < 600 { "5xx" } else { "" }
bw_d = to_float(get(bw_h, ["duration_us"]) ?? -1) ?? -1.0
if bw_d >= 0.0 { bw_m.duration_s = bw_d / 1000000.0 }
bw_m.stores = bw_hk == "in_end" && %bw_stores != false
if bw_m.stores == true {
  bw_m.db_s = (to_float(get(bw_h, ["db_us"]) ?? 0) ?? 0.0) / 1000000.0
  bw_m.db_n = to_float(get(bw_h, ["db_n"]) ?? 0) ?? 0.0
  bw_m.cache_s = (to_float(get(bw_h, ["cache_us"]) ?? 0) ?? 0.0) / 1000000.0
  bw_m.cache_n = to_float(get(bw_h, ["cache_n"]) ?? 0) ?? 0.0
${optionalTotalVrl("cache_hit_n", "cache_hit_n", 1)}${optionalTotalVrl("cache_miss_n", "cache_miss_n", 1)}${optionalTotalVrl("db_wait_s", "db_wait_us", 1000000)}}
. = { "service": .service, "bw_hk": bw_hk, "bw_m": bw_m, "timestamp": .timestamp }
`;
}

/** The stack and agent metric input (no tenant labels: the agent's are stamped by the proxy). */
export const METRIC_PREP_VRL = metricPrepVrl(false);

/** Placeholder written over protected ID fields while the filter runs. */
const PROTECT = "BWPROTECT";

/** A VRL raw-string literal for a pattern in the shared JS / Rust-regex subset. */
export function vrlRegex(pattern: string): string {
  return `r'${pattern.replace(/'/g, "\\x27")}'`;
}

/** A VRL string literal (service names, replacements). */
export function vrlString(s: string): string {
  return JSON.stringify(s);
}

export interface VrlPattern {
  name: string;
  pattern: string;
  /** JS replacement ($1 = group 1). */
  replacement: string;
}

/** VRL applying the filter (design 19.2) to field FIELD, protecting trace/hop IDs. */
function filterFieldVrl(field: string, patterns: readonly VrlPattern[]): string {
  const rules = patterns
    .map((p) => `  bw_f = replace(bw_f, ${vrlRegex(p.pattern)}, ${vrlString(p.replacement)})  # ${p.name.replace(/[^a-z0-9_ -]/gi, "")}`)
    .join("\n");
  return `if is_string(${field}) {
  bw_f = to_string(${field}) ?? ""
  bw_ids = parse_regex_all(bw_f, r'(?P<w>(?:trace_id|hop_id|parent_hop|parent_id)"?\\s*[:=]\\s*"?[0-9a-f]{16,32})') ?? []
  bw_saved = []
  for_each(bw_ids) -> |i, mt| {
    w = to_string(mt.w)
    if w != "" {
      bw_saved = push(bw_saved, w)
      bw_f = replace(bw_f, w, "${PROTECT}" + to_string(i) + "X")
    }
  }
${rules}
  for_each(bw_saved) -> |i, w| { bw_f = replace(bw_f, "${PROTECT}" + to_string(i) + "X", to_string(w) ?? "") }
  ${field} = bw_f
}
`;
}

/** Snapshot used when the agent has never reached backwork, and by the stack collector. */
export function defaultSnapshot(): ControlsSnapshot {
  const all = Object.fromEntries(COLLECTOR_FEATURES.map((f) => [f, true])) as Record<CollectorFeature, boolean>;
  return {
    version: "default",
    project: all,
    services: {},
    patterns: BUILT_IN_PATTERNS.map((p) => ({ name: p.name, pattern: p.pattern, replacement: p.replacement })),
    serviceNames: {},
    excludedPaths: [],
  };
}

/**
 * Excluded paths (BAC-82): drop a hop record whose `path` or `op` (the route template) matches,
 * and an ordinary line that mentions a matching path, before anything leaves the host. Runs in
 * bw_controls, which feeds both the loki sink and bw_metric_prep, so a dropped record is neither
 * stored nor counted. Needs `bw_kind`, `bw_type` and `bw_h` set. No patterns: nothing.
 */
export function excludedPathsVrl(patterns: readonly string[]): string {
  const whole = pathMatchSource(patterns);
  const line = lineMatchSource(patterns);
  if (whole === null || line === null) return "";
  return `# Excluded paths (BAC-82): matching requests are dropped here, before sending.
if bw_type == "hop" {
  bw_xp = replace(to_string(get(bw_h, ["path"]) ?? "") ?? "", r'[?#].*$', "")
  bw_xo = replace(to_string(get(bw_h, ["op"]) ?? "") ?? "", r'[?#].*$', "")
  if match(bw_xp, ${vrlRegex(whole)}) || match(bw_xo, ${vrlRegex(whole)}) { abort }
}
if bw_kind == "log" && match(to_string(.message) ?? "", ${vrlRegex(line)}) { abort }
`;
}

/** VRL variable for a feature switch. */
const sw = (f: CollectorFeature): string => `bw_on_${f}`;

/** Design 19: switches and filter, as one remap program for one project. */
export function controlsVrl(snap: ControlsSnapshot): string {
  const lines: string[] = [
    `# backwork switches and sensitive-data filter (design 19). Version ${snap.version.replace(/[^a-z0-9]/gi, "")}.`,
    REDETECT_VRL.trimEnd(),
    NEST_LEVEL_VRL.trimEnd(),
    NAMING_VRL.trimEnd(),
    ...relabelVrl(snap.serviceNames),
  ];
  for (const f of COLLECTOR_FEATURES) lines.push(`${sw(f)} = ${snap.project[f] ? "true" : "false"}`);
  const overrides = Object.entries(snap.services).filter(([, eff]) => COLLECTOR_FEATURES.some((f) => eff[f] !== snap.project[f]));
  if (overrides.length > 0) lines.push(`bw_svc = to_string(.service) ?? ""`);
  for (const [svc, eff] of overrides) {
    const diffs = COLLECTOR_FEATURES.filter((f) => eff[f] !== snap.project[f]);
    lines.push(`if bw_svc == ${vrlString(svc)} {`);
    for (const f of diffs) lines.push(`  ${sw(f)} = ${eff[f] ? "true" : "false"}`);
    lines.push(`}`);
  }
  lines.push(`bw_kind = to_string(.kind) ?? "log"
bw_type = to_string(%bw_type) ?? ""
bw_h = object(%bw_hop) ?? {}
bw_via = to_string(get(bw_h, ["via"]) ?? "") ?? ""`);
  const excluded = excludedPathsVrl(snap.excludedPaths);
  if (excluded) lines.push(excluded.trimEnd());
  lines.push(`if bw_kind == "log" && !${sw("logs")} { abort }
if bw_kind == "hop" && !${sw("hops")} { abort }
if bw_type == "link" && !${sw("linked_ids")} { abort }
if bw_type == "hop" && (bw_via == "db" || bw_via == "cache") && !${sw("stores")} { abort }
%bw_metrics = ${sw("metrics")}
%bw_stores = ${sw("stores")}
bw_drop_f = !${sw("named_fields")}
bw_drop_s = !${sw("stores")}
bw_drop_q = !${sw("statements")}
bw_drop_p = !${sw("paths")}
if bw_type == "hop" && (bw_drop_f || bw_drop_s || bw_drop_q || bw_drop_p) {
  if (to_string(%bw_fmt) ?? "") == "json" {
    bw_o = object(parse_json(to_string(.message) ?? "") ?? {}) ?? {}
    bw_box = to_string(%bw_box) ?? ""
    bw_c = bw_o
    if bw_box != "" { bw_c = object(get(bw_o, [bw_box]) ?? {}) ?? {} }
    bw_c = filter(bw_c) -> |k, _v| { !((bw_drop_f && starts_with(k, "f_")) || (bw_drop_s && includes(${JSON.stringify(STORE_TOTAL_FIELDS).replace(/,/g, ", ")}, k)) || (bw_drop_q && includes(["table", "stmt"], k)) || (bw_drop_p && k == "path")) }
    if bw_box == "" { bw_o = bw_c } else { bw_o = set(bw_o, [bw_box], bw_c) ?? bw_o }
    .message = encode_json(bw_o)
  } else {
    # Only the pairs before stmt are edited; stmt is removed whole (Query text off) or kept as is.
    bw_line = to_string(.message) ?? ""
    bw_lp = parse_regex(bw_line, r'^(?P<head>.*?)(?P<tail> stmt=.*)?$') ?? {}
    bw_head = to_string(get(bw_lp, ["head"]) ?? bw_line) ?? bw_line
    bw_tail = to_string(get(bw_lp, ["tail"]) ?? "") ?? ""
    if bw_drop_f { bw_head = replace(bw_head, r' f_[a-z0-9_]+=\\S*', "") }
    if bw_drop_s { bw_head = replace(bw_head, ${vrlRegex(STORE_TOTALS_KV_PATTERN)}, "") }
    if bw_drop_p { bw_head = replace(bw_head, r' path=\\S*', "") }
    if bw_drop_q {
      bw_head = replace(bw_head, r' table=\\S*', "")
      bw_tail = ""
    }
    .message = bw_head + bw_tail
    .display = .message
  }
}`);
  if (snap.patterns.length > 0) {
    lines.push(`if ${sw("filter")} {`);
    lines.push(`bw_orig = .message`);
    lines.push(filterFieldVrl(".message", snap.patterns).trimEnd());
    lines.push(`if .display == bw_orig { .display = .message } else {`);
    lines.push(filterFieldVrl(".display", snap.patterns).trimEnd());
    lines.push(`}`);
    lines.push(`}`);
  }
  lines.push(SLIM_VRL.trimEnd());
  return lines.join("\n") + "\n";
}

/**
 * Ordinary lines of a source whose hop records name a service are stored under that service's
 * own name (BAC-51 step 2); `source` keeps the container. Runs before the switches, so a
 * per-service switch acts on the lines it names. A source with no hop records is never in the
 * map, so its lines keep their label. Empty map: nothing.
 */
export function relabelVrl(names: Readonly<Record<string, string>>): string[] {
  const entries = Object.entries(names).filter(([src, svc]) => src && svc && src !== svc);
  if (!entries.length) return [];
  const obj = `{${entries.map(([src, svc]) => `${vrlString(src)}: ${vrlString(svc)}`).join(", ")}}`;
  return [`# Ordinary lines under the service's own name (source -> service from hop records).
if (to_string(.kind) ?? "log") == "log" {
  bw_own = get(${obj}, [to_string(.source) ?? ""]) ?? null
  if bw_own != null { .service = bw_own }
}`];
}

/**
 * NestJS's built-in logger writes its level as a word in the line, not as a field:
 * "[Nest] 4120  - 11/12/2026, 10:01:03 AM    WARN [Payouts] slow bank", often wrapped in ANSI
 * colour codes. Read it there (BAC-41 row 9). In the controls program, so every agent and the
 * stack collector apply it without a reinstall. Lines with a structured level are untouched.
 */
export const NEST_LEVEL_VRL = `# NestJS logger: the level word after the pid and timestamp.
if (to_string(.kind) ?? "log") == "log" && contains(to_string(.message) ?? "", "[Nest]") {
  bw_nest = parse_regex(to_string(.message) ?? "", r'^(?:\\x1b\\[[0-9;]*m)*\\[Nest\\][^\\n]*?\\s(?:\\x1b\\[[0-9;]*m)?\\s*(?P<lvl>LOG|ERROR|WARN|DEBUG|VERBOSE|FATAL)(?:\\x1b\\[[0-9;]*m)?\\s') ?? {}
  bw_nl = to_string(get(bw_nest, ["lvl"]) ?? "") ?? ""
  if bw_nl == "ERROR" { .level = "error" } else if bw_nl == "WARN" { .level = "warn" } else if bw_nl == "FATAL" { .level = "fatal" } else if bw_nl == "DEBUG" || bw_nl == "VERBOSE" { .level = "debug" } else if bw_nl == "LOG" { .level = "info" }
}
`;

/**
 * Detection again, inside the controls program, for lines that may hold a hop record: agents
 * installed earlier run an older bw_detect (from their agent.yaml) that loses a record over a
 * repeated key or reads text inside `stmt` as fields. The controls program reaches them through
 * the poller, so the current rules apply without a reinstall. Detection is idempotent.
 */
export const REDETECT_VRL = `# Hop detection with the current rules (repeated keys, stmt read first), for every agent.
if contains(to_string(.message) ?? "", "trace_id=") {
  %bw_type = ""
${DETECT_VRL.trimEnd().split("\n").map((l) => (l ? "  " + l : l)).join("\n")}
}
`;

/** First step of bw_controls (so agents installed earlier get it through the controls poller):
 *  a hop record is named by its own service field, the name the developer set and the one that
 *  travels between hops; the collector's container or process name stays in `.source`, which
 *  ordinary lines share and which joins them to the hop (BAC-49). */
export const NAMING_VRL = `# Hop records are named by their own service field; the container stays in .source (BAC-49).
if !exists(.source) { .source = .service }
if (to_string(.kind) ?? "") == "hop" {
  bw_rs = to_string(get(object(%bw_hop) ?? {}, ["service"]) ?? "") ?? ""
  if match(bw_rs, r'^[\\x21-\\x7e]{1,200}$') { .service = bw_rs }
}
`;

/** Fields a stored line keeps. Everything else Vector's docker source adds (the container's
 *  whole label set, container id, image, creation time, stream) is dropped: the pages read only
 *  these, and the label set alone turned a 150-byte hop record into about 3 KB. The hop fields
 *  stay inside the line itself; the parsed copy lives in event metadata, which is not stored. */
export const STORED_FIELDS: readonly string[] = ["message", "display", "service", "source", "host", "project", "level", "kind", "timestamp"];

/** Last step of bw_controls: keep STORED_FIELDS only; `display` only when it differs. */
export const SLIM_VRL = `# Store only what the pages read (BAC-49).
bw_keep = {"message": .message, "service": .service, "source": .source, "level": .level, "kind": .kind, "timestamp": .timestamp}
if is_string(.host) && .host != "" { bw_keep.host = .host }
if is_string(.project) && .project != "" { bw_keep.project = .project }
if is_string(.display) && .display != .message { bw_keep.display = .display }
. = bw_keep
`;

// ---------------------------------------------------------------------------
// Records intake (BAC-96)
// ---------------------------------------------------------------------------

/**
 * POST /ingest/records (and the OTLP logs endpoint) hands lines to the stack collector's
 * `records` input after the dashboard has authenticated the post, enforced the project's
 * switches and excluded paths, relabelled ordinary lines and applied the organisation's filter
 * (the same enforceStreams pass an agent's push gets). The collector then runs the collectors'
 * own normalize / detect / controls / metric transforms on them, so a line posted here is stored
 * and counted exactly as an agent's would be. Decision: docs/adr/0001-no-install-intake.md.
 */
export const RECORDS_INTAKE = { port: 8687, path: "/records" } as const;

/** Fields of one event the intake posts to the `records` input (one JSON object per line). */
export const RecordField = {
  Message: "message",
  Service: "service",
  Source: "source",
  Host: "host",
  Project: "project",
  OrgId: "org_id",
  /** Receive time, Unix nanoseconds as a decimal string. */
  Time: "bw_ts",
  /** The Performance figures switch for this line's service (false: no hop metrics). */
  Metrics: "bw_metrics",
  /** The Database and cache switch for this line's service (false: no store totals). */
  Stores: "bw_stores",
} as const;
export type RecordField = (typeof RecordField)[keyof typeof RecordField];

/** One event for the `records` input. */
export interface RecordEvent {
  [RecordField.Message]: string;
  [RecordField.Service]: string;
  [RecordField.Source]: string;
  [RecordField.Host]?: string;
  [RecordField.Project]: string;
  [RecordField.OrgId]: string;
  [RecordField.Time]: string;
  [RecordField.Metrics]: boolean;
  [RecordField.Stores]: boolean;
}

/** In place of bw_normalize for posted lines: the labels come from the intake, level and display
 *  text from the line as for every other input. */
export const RECORDS_NORMALIZE_VRL = `# Records intake (BAC-96): authenticated, switched and filtered by the dashboard.
.service = to_string(.${RecordField.Service}) ?? ""
if !match(.service, r'^[\\x21-\\x7e]{1,200}$') { .service = "unknown" }
.source = to_string(.${RecordField.Source}) ?? ""
if .source == "" { .source = .service }
.project = to_string(.${RecordField.Project}) ?? ""
.host = to_string(.${RecordField.Host}) ?? ""
%bw_org = to_string(.${RecordField.OrgId}) ?? ""
%bw_project = .project
%bw_rec_metrics = .${RecordField.Metrics} != false
%bw_rec_stores = .${RecordField.Stores} != false
bw_ns = to_int(.${RecordField.Time}) ?? 0
if bw_ns > 0 { .timestamp = from_unix_timestamp(bw_ns, unit: "nanoseconds") ?? .timestamp }
del(.${RecordField.Time})
del(.${RecordField.Metrics})
del(.${RecordField.Stores})
del(.${RecordField.OrgId})

${LEVEL_VRL}`;

/** The intake already enforced the project's switches, excluded paths and service names and ran
 *  the organisation's filter (whose built-ins it may have switched off), so the collector's
 *  controls program here runs with everything on and no patterns: it only re-detects, reads the
 *  NestJS level, names hop records and slims the event. */
export function recordsSnapshot(): ControlsSnapshot {
  return { ...defaultSnapshot(), version: "records", patterns: [] };
}

/** After bw_rec_controls: the tenant label back on the event and the per-service metric switches
 *  the intake resolved. */
export const RECORDS_TENANT_VRL = `# Tenant label and the intake's metric switches (BAC-96).
.org_id = to_string(%bw_org) ?? ""
%bw_metrics = %bw_metrics != false && %bw_rec_metrics != false
%bw_stores = %bw_stores != false && %bw_rec_stores != false
`;

/** The records intake's metric pipeline: tenant-labelled, its own names, one limit across tenants. */
export const RECORDS_METRICS: MetricPipeline = { prefix: "bw_rec_", input: "bw_rec_tenant", tenant: true, valueLimit: LABEL_VALUE_LIMIT * 10 };

/** Docker label that marks backwork's own containers; the stack collector reads only those. */
export const COLLECT_LABEL = "dev.backwork.collect=true";

// ---------------------------------------------------------------------------
// YAML assembly
// ---------------------------------------------------------------------------

/** Vector expands $VAR in config files; a literal $ is written $$. */
export function inlineVrl(vrl: string, indent: number): string {
  const pad = " ".repeat(indent);
  return vrl
    .replace(/\$/g, "$$$$")
    .trimEnd()
    .split("\n")
    .map((l) => (l.length ? pad + l : ""))
    .join("\n");
}

// `synthetic` (BAC-80) on all three, so monitors are left out wherever health checks are.
const TAGS = {
  duration: ["service", "dir", "via", "method", "op", "peer", "outcome", "status_class", "synthetic"],
  // op so health checks can be left out of "in progress" (started minus finished) as well.
  started: ["service", "dir", "via", "op", "synthetic"],
  store: ["service", "via", "method", "op", "synthetic"],
} as const;

function tagsYaml(keys: readonly string[], indent: number, extra: Record<string, string> = {}): string {
  const pad = " ".repeat(indent);
  const rows = keys.map((k) => `${pad}${k}: "{{ bw_m.${k} }}"`);
  for (const [k, v] of Object.entries(extra)) rows.push(`${pad}${k}: ${v}`);
  return rows.join("\n");
}

/** A store counter fed by a total that only some services report (proposed HOP-25, HOP-26). Each
 *  gets its own route and transform: log_to_metric drops the whole event when any one of its
 *  metrics' fields is missing, which would take the existing db and cache counters with it. */
interface OptionalStoreMetric {
  route: string;
  /** Transform name after the pipeline prefix. */
  transform: string;
  metric: MetricName;
  /** Field under `.bw_m`, set by METRIC_PREP_VRL only when the record carries the total. */
  field: string;
  store: StoreSeries;
}

const OPTIONAL_STORE_METRICS: readonly OptionalStoreMetric[] = [
  { route: "cache_hits", transform: "hop_store_cache_hit", metric: MetricName.StoreCalls, field: "cache_hit_n", store: StoreSeries.CacheHit },
  { route: "cache_misses", transform: "hop_store_cache_miss", metric: MetricName.StoreCalls, field: "cache_miss_n", store: StoreSeries.CacheMiss },
  { route: "db_waits", transform: "hop_store_db_wait", metric: MetricName.StoreSeconds, field: "db_wait_s", store: StoreSeries.DbWait },
];

/** Where a copy of the metric transforms reads from and what it is called. */
export interface MetricPipeline {
  /** Prefix of every transform name ("bw_" for the collectors' own pipeline). */
  prefix: string;
  /** The transform whose output feeds the metrics. */
  input: string;
  /** Add org_id and project labels (the records intake). */
  tenant: boolean;
  /** Distinct values per label (tag_cardinality_limit). */
  valueLimit: number;
}

/** The collectors' own metric pipeline: what the stack and the agent have always generated. */
export const COLLECTOR_METRICS: MetricPipeline = { prefix: "bw_", input: "bw_controls", tenant: false, valueLimit: LABEL_VALUE_LIMIT };

/** The metric transforms shared by both collectors (design 5.3), and by the records intake
 *  (BAC-96) under its own names with tenant labels. */
export function metricTransformsYaml(p: MetricPipeline = COLLECTOR_METRICS): string {
  const n = (name: string): string => p.prefix + name;
  const scope = p.tenant ? ["org_id", "project"] : [];
  const tags = {
    duration: [...TAGS.duration, ...scope],
    started: [...TAGS.started, ...scope],
    store: [...TAGS.store, ...scope],
  };
  const storeMetric = (name: MetricName, field: string, store: string): string => `      - type: counter
        field: bw_m.${field}
        increment_by_value: true
        name: ${name}
        tags:
${tagsYaml(tags.store, 10, { store })}`;
  return `  ${n("metric_prep")}:
    type: remap
    inputs: [${p.input}]
    drop_on_abort: true
    source: |
${inlineVrl(metricPrepVrl(p.tenant), 6)}

  ${n("hop_route")}:
    type: route
    inputs: [${n("metric_prep")}]
    route:
      ends: '(.bw_hk == "in_end" || .bw_hk == "out_end") && exists(.bw_m.duration_s)'
      starts: '.bw_hk == "in" || .bw_hk == "out"'
      stores: '.bw_m.stores == true'
${OPTIONAL_STORE_METRICS.map((m) => `      ${m.route}: '.bw_m.stores == true && exists(.bw_m.${m.field})'\n`).join("")}
  ${n("hop_duration")}:
    type: log_to_metric
    inputs: [${n("hop_route")}.ends]
    metrics:
      - type: histogram
        field: bw_m.duration_s
        name: ${MetricName.Duration}
        tags:
${tagsYaml(tags.duration, 10)}

  ${n("hop_started")}:
    type: log_to_metric
    inputs: [${n("hop_route")}.starts]
    metrics:
      - type: counter
        field: bw_hk
        name: ${MetricName.Started}
        tags:
${tagsYaml(tags.started, 10)}

  ${n("hop_store")}:
    type: log_to_metric
    inputs: [${n("hop_route")}.stores]
    metrics:
${storeMetric(MetricName.StoreSeconds, "db_s", "db")}
${storeMetric(MetricName.StoreSeconds, "cache_s", "cache")}
${storeMetric(MetricName.StoreCalls, "db_n", "db")}
${storeMetric(MetricName.StoreCalls, "cache_n", "cache")}
${OPTIONAL_STORE_METRICS.map((m) => `
  ${n(m.transform)}:
    type: log_to_metric
    inputs: [${n("hop_route")}.${m.route}]
    metrics:
${storeMetric(m.metric, m.field, m.store)}
`).join("")}
  ${n("hop_cardinality")}:
    type: tag_cardinality_limit
    inputs: [${n("hop_duration")}, ${n("hop_started")}, ${n("hop_store")}, ${OPTIONAL_STORE_METRICS.map((m) => n(m.transform)).join(", ")}]
    mode: exact
    value_limit: ${p.valueLimit}
    limit_exceeded_action: drop_tag
`;
}

/**
 * BAC-94: join the lines of one multi-line entry, per container stream (or PM2 file), before
 * anything else reads them. Two reduce stages, because a reduce sees one line at a time:
 *   bw_join_lines   a continuation line (lib/log-join CONTINUATION_PATTERN) joins the line before;
 *   bw_join_blocks  an entry right after a bare error header, or after a template excerpt that
 *                   ends in a blank line, joins it (the `Name: message` line, the ejs message).
 * JSON lines and hop records go around both (bw_join_route.solo). bw_join_tidy drops the trailing
 * blank line and caps the size.
 */
export function joinTransformsYaml(inputs: readonly string[]): string {
  const group = "[container_id, stream, file]";
  return `  bw_join_route:
    type: route
    inputs: [${inputs.join(", ")}]
    route:
      solo: 'match(to_string(.message) ?? "", ${vrlRegex(SOLO_PATTERN).replace(/\$/g, "$$$$").replace(/'/g, "''")})'

  bw_join_lines:
    type: reduce
    inputs: [bw_join_route._unmatched]
    group_by: ${group}
    expire_after_ms: ${JOIN_TIMEOUT_MS}
    flush_period_ms: 250
    max_events: ${JOIN_MAX_LINES}
    merge_strategies:
      message: concat_newline
    starts_when: |
${inlineVrl(`!match(to_string(.message) ?? "", ${vrlRegex(CONTINUATION_PATTERN)})`, 6)}

  bw_join_blocks:
    type: reduce
    inputs: [bw_join_lines]
    group_by: ${group}
    # Longer than bw_join_lines waits, so a header is still open when the entry after it, held by
    # bw_join_lines until its own timeout, arrives.
    expire_after_ms: ${JOIN_TIMEOUT_MS * 2 + 500}
    flush_period_ms: 250
    max_events: 20
    merge_strategies:
      message: concat_newline
    ends_when: |
${inlineVrl(`m = to_string(.message) ?? ""
# Keep the entry open after a bare error header, or a template excerpt ending in a blank line.
header = !contains(m, "\\n") && match(m, ${vrlRegex(ERROR_HEADER_PATTERN)})
excerpt = match(m, r'\\n\\s*$') && match(m, r'(?m)^\\s*>>\\s*\\d+\\|')
!(header || excerpt)`, 6)}

  bw_join_tidy:
    type: remap
    inputs: [bw_join_blocks]
    source: |
${inlineVrl(`m = to_string(.message) ?? ""
if contains(m, "\\n") {
  m = replace(m, r'\\s+$', "")
  if strlen(m) > ${JOIN_MAX_CHARS} { m = truncate(m, limit: ${JOIN_MAX_CHARS}) }
  .message = m
}
del(.timestamp_end)`, 6)}
`;
}

/** The bw_controls transform, standalone (the agent's reloadable file). */
export function controlsTransformYaml(snap: ControlsSnapshot): string {
  return `# Generated by backwork from this project's switches and filter patterns.
# Replaced by the backwork-agent-controls poller when they change; Vector
# reloads it (--watch-config).
transforms:
  bw_controls:
    type: remap
    inputs: [bw_detect]
    drop_on_abort: true
    source: |
${inlineVrl(controlsVrl(snap), 6)}
`;
}

const bucketsYaml = `[${HOP_BUCKETS.join(", ")}]`;

/** infra/vector/vector.yaml: the stack's own collector on the backwork host. */
export function stackConfigYaml(): string {
  return `# GENERATED by infra/vector/generate.ts from
# dashboard/app/lib/agent/vector-config.server.ts. Do not edit by hand.
#
# backwork collector. Tails backwork's OWN containers (label
# ${COLLECT_LABEL}): every other service ships through the agent
# under its organisation, so reading the whole host would store each of its
# lines twice, once without an org. Derives a friendly service name,
# normalises the level, detects Correlator hop records and link lines
# (kind="hop"), applies the sensitive-data filter, keeps only the fields the
# pages read, ships to Loki, and exposes hop metrics + its own metrics for VM.
# backwork's own telemetry belongs to the platform org: no switches here.
data_dir: /vector-data

sources:
  docker:
    type: docker_logs
    include_labels:
      - "${COLLECT_LABEL}"
    exclude_containers:
      - vector            # don't tail ourselves

  vector_metrics:
    type: internal_metrics

  # Lines posted to /ingest/records and /ingest/otlp/v1/logs, after the dashboard's
  # authentication, switches and filter (BAC-96). Reachable only on the compose network.
  records:
    type: http_server
    address: 0.0.0.0:${RECORDS_INTAKE.port}
    path: ${RECORDS_INTAKE.path}
    method: POST
    framing:
      method: newline_delimited
    decoding:
      codec: json
    acknowledgements:
      enabled: true

transforms:
${joinTransformsYaml(["docker"])}
  bw_normalize:
    type: remap
    inputs: [bw_join_tidy, bw_join_route.solo]
    source: |
${inlineVrl(normalizeVrl(CollectorKind.Stack), 6)}

  bw_detect:
    type: remap
    inputs: [bw_normalize]
    source: |
${inlineVrl(DETECT_VRL, 6)}

  bw_controls:
    type: remap
    inputs: [bw_detect]
    drop_on_abort: true
    source: |
${inlineVrl(controlsVrl(defaultSnapshot()), 6)}

${metricTransformsYaml()}
  bw_rec_normalize:
    type: remap
    inputs: [records]
    source: |
${inlineVrl(RECORDS_NORMALIZE_VRL, 6)}

  bw_rec_detect:
    type: remap
    inputs: [bw_rec_normalize]
    source: |
${inlineVrl(DETECT_VRL, 6)}

  bw_rec_controls:
    type: remap
    inputs: [bw_rec_detect]
    drop_on_abort: true
    source: |
${inlineVrl(controlsVrl(recordsSnapshot()), 6)}

  bw_rec_tenant:
    type: remap
    inputs: [bw_rec_controls]
    source: |
${inlineVrl(RECORDS_TENANT_VRL, 6)}

${metricTransformsYaml(RECORDS_METRICS)}
sinks:
  loki:
    type: loki
    inputs: [bw_controls]
    endpoint: http://loki:3100
    encoding:
      codec: json
    labels:
      service: "{{ service }}"
      source: "{{ source }}"
      level: "{{ level }}"
      kind: "{{ kind }}"
    out_of_order_action: accept
    remove_label_fields: false

  # Posted lines, stamped with their organisation and project as the ingest proxy stamps an agent's.
  loki_records:
    type: loki
    inputs: [bw_rec_tenant]
    endpoint: http://loki:3100
    encoding:
      codec: json
    labels:
      service: "{{ service }}"
      source: "{{ source }}"
      host: "{{ host }}"
      level: "{{ level }}"
      kind: "{{ kind }}"
      org_id: "{{ org_id }}"
      project: "{{ project }}"
    out_of_order_action: accept
    remove_label_fields: false

  prometheus:
    type: prometheus_exporter
    inputs: [vector_metrics, bw_hop_cardinality, bw_rec_hop_cardinality]
    address: 0.0.0.0:9598
    buckets: ${bucketsYaml}
    # Keep idle hop series for 15 minutes so rate() sees no false resets.
    flush_period_secs: 900
`;
}

/**
 * The agent's main config (/etc/backwork/vector/agent.yaml). Placeholders
 * __NAME__, __ENDPOINT__, __TOKEN__ are filled in by the installer.
 * bw_controls comes from the separate, reloadable controls.yaml.
 */
export function agentConfigYaml(): string {
  return `# backwork agent (generated by backwork /install.sh).
data_dir: /var/lib/backwork-vector

sources:
  docker:
    type: docker_logs
    # Prefix match: every agent instance on the host (backwork-agent[-<instance>],
    # backwork-agent-controls[-<instance>]) is left out.
    exclude_containers: ["backwork-agent"]
    # --include <prefix,...>: only these container-name prefixes (line removed when empty).
    include_containers: [__INCLUDE__]
  # Services under PM2 (design 4): the installer mounts PM2's log directory
  # here; empty when the host has none.
  pm2:
    type: file
    include: ["/pm2-logs/*.log"]
    read_from: end
    ignore_older_secs: 86400

transforms:
${joinTransformsYaml(["docker", "pm2"])}
  bw_normalize:
    type: remap
    inputs: [bw_join_tidy, bw_join_route.solo]
    source: |
${inlineVrl(normalizeVrl(CollectorKind.Agent), 6)}

  bw_detect:
    type: remap
    inputs: [bw_normalize]
    source: |
${inlineVrl(DETECT_VRL, 6)}

${metricTransformsYaml()}
sinks:
  loki:
    type: loki
    inputs: [bw_controls]
    endpoint: __ENDPOINT__
    auth:
      strategy: bearer
      token: __TOKEN__
    # compression none = JSON push body, so the ingest proxy can stamp the
    # tenant, enforce switches and filter again.
    compression: none
    encoding:
      codec: json
    labels:
      service: "{{ service }}"
      source: "{{ source }}"
      host: "{{ host }}"
      level: "{{ level }}"
      kind: "{{ kind }}"

  hop_metrics:
    type: prometheus_remote_write
    inputs: [bw_hop_cardinality]
    endpoint: __ENDPOINT__/metrics/api/v1/write?kind=hop
    # The healthcheck posts an empty write, which VictoriaMetrics answers 400.
    healthcheck:
      enabled: false
    auth:
      strategy: bearer
      token: __TOKEN__
    buckets: ${bucketsYaml}
`;
}
