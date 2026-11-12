/**
 * The Vector configuration for both collectors: the stack's own collector
 * (`infra/vector/vector.yaml`, generated from this module by
 * `infra/vector/generate.ts`) and the backwork agent written by
 * `/install.sh`. One source so the two can never drift (a test checks the
 * checked-in file equals `stackConfigYaml()`).
 *
 * Pipeline (design 4, 5, 19):
 *   source(s) -> bw_normalize -> bw_detect -> bw_controls -> loki
 *                                                 \-> bw_metric_prep -> bw_hop_route
 *                                                       -> bw_hop_duration / bw_hop_started / bw_hop_store
 *                                                       -> bw_hop_cardinality -> prometheus (stack) | remote write (agent)
 *
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
  FEATURES,
  type ControlsSnapshot,
  type Feature,
} from "~/lib/controls.server";

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
.project = to_string(get(labels, ["coolify.projectName"]) ?? "") ?? ""
.role = to_string(get(labels, ["com.docker.compose.service"]) ?? "") ?? ""
${host}
# Structured JSON logs: lift level/msg.
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

# Heuristic level for unstructured lines (proxies, runtimes, DBs, Elixir console).
if .level == "info" {
  m = downcase(to_string(.message) ?? "")
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
}

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
  bw_src = parse_key_value(bw_raw, key_value_delimiter: "=", field_delimiter: " ") ?? {}
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

/** Design 5.3: the labels and values the metric transforms read, under `.bw_m`. */
export const METRIC_PREP_VRL = `# Hop metrics input (design 5.3). Only hop records reach the metrics.
if (to_string(%bw_type) ?? "") != "hop" || %bw_metrics == false { abort }
bw_h = object(%bw_hop) ?? {}
bw_hk = to_string(get(bw_h, ["hop"]) ?? "") ?? ""
bw_m = {}
bw_l = to_string(.service) ?? ""
if !match(bw_l, r'^[\\x21-\\x7e]{1,200}$') { bw_l = "" }
bw_m.service = bw_l
bw_m.dir = if starts_with(bw_hk, "in") { "in" } else { "out" }
${labelVrl("via", 'get(bw_h, ["via"])')}${labelVrl("method", 'get(bw_h, ["method"])')}${labelVrl("op", 'get(bw_h, ["op"])')}${labelVrl("peer", 'get(bw_h, ["peer"])')}${labelVrl("outcome", 'get(bw_h, ["outcome"])')}bw_st = to_int(get(bw_h, ["status"]) ?? 0) ?? 0
bw_m.status_class = if bw_st >= 200 && bw_st < 300 { "2xx" } else if bw_st >= 300 && bw_st < 400 { "3xx" } else if bw_st >= 400 && bw_st < 500 { "4xx" } else if bw_st >= 500 && bw_st < 600 { "5xx" } else { "" }
bw_d = to_float(get(bw_h, ["duration_us"]) ?? -1) ?? -1.0
if bw_d >= 0.0 { bw_m.duration_s = bw_d / 1000000.0 }
bw_m.stores = bw_hk == "in_end" && %bw_stores != false
if bw_m.stores == true {
  bw_m.db_s = (to_float(get(bw_h, ["db_us"]) ?? 0) ?? 0.0) / 1000000.0
  bw_m.db_n = to_float(get(bw_h, ["db_n"]) ?? 0) ?? 0.0
  bw_m.cache_s = (to_float(get(bw_h, ["cache_us"]) ?? 0) ?? 0.0) / 1000000.0
  bw_m.cache_n = to_float(get(bw_h, ["cache_n"]) ?? 0) ?? 0.0
}
. = { "service": .service, "bw_hk": bw_hk, "bw_m": bw_m, "timestamp": .timestamp }
`;

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
  const all = Object.fromEntries(FEATURES.map((f) => [f, true])) as Record<Feature, boolean>;
  return {
    version: "default",
    project: all,
    services: {},
    patterns: BUILT_IN_PATTERNS.map((p) => ({ name: p.name, pattern: p.pattern, replacement: p.replacement })),
  };
}

/** VRL variable for a feature switch. */
const sw = (f: Feature): string => `bw_on_${f}`;

/** Design 19: switches and filter, as one remap program for one project. */
export function controlsVrl(snap: ControlsSnapshot): string {
  const lines: string[] = [`# backwork switches and sensitive-data filter (design 19). Version ${snap.version.replace(/[^a-z0-9]/gi, "")}.`];
  for (const f of FEATURES) lines.push(`${sw(f)} = ${snap.project[f] ? "true" : "false"}`);
  const overrides = Object.entries(snap.services).filter(([, eff]) => FEATURES.some((f) => eff[f] !== snap.project[f]));
  if (overrides.length > 0) lines.push(`bw_svc = to_string(.service) ?? ""`);
  for (const [svc, eff] of overrides) {
    const diffs = FEATURES.filter((f) => eff[f] !== snap.project[f]);
    lines.push(`if bw_svc == ${vrlString(svc)} {`);
    for (const f of diffs) lines.push(`  ${sw(f)} = ${eff[f] ? "true" : "false"}`);
    lines.push(`}`);
  }
  lines.push(`bw_kind = to_string(.kind) ?? "log"
bw_type = to_string(%bw_type) ?? ""
bw_h = object(%bw_hop) ?? {}
bw_via = to_string(get(bw_h, ["via"]) ?? "") ?? ""
if bw_kind == "log" && !${sw("logs")} { abort }
if bw_kind == "hop" && !${sw("hops")} { abort }
if bw_type == "link" && !${sw("linked_ids")} { abort }
if bw_type == "hop" && (bw_via == "db" || bw_via == "cache") && !${sw("stores")} { abort }
%bw_metrics = ${sw("metrics")}
%bw_stores = ${sw("stores")}
bw_drop_f = !${sw("named_fields")}
bw_drop_s = !${sw("stores")}
if bw_type == "hop" && (bw_drop_f || bw_drop_s) {
  if (to_string(%bw_fmt) ?? "") == "json" {
    bw_o = object(parse_json(to_string(.message) ?? "") ?? {}) ?? {}
    bw_box = to_string(%bw_box) ?? ""
    bw_c = bw_o
    if bw_box != "" { bw_c = object(get(bw_o, [bw_box]) ?? {}) ?? {} }
    bw_c = filter(bw_c) -> |k, _v| { !((bw_drop_f && starts_with(k, "f_")) || (bw_drop_s && includes(["db_n", "db_us", "cache_n", "cache_us"], k))) }
    if bw_box == "" { bw_o = bw_c } else { bw_o = set(bw_o, [bw_box], bw_c) ?? bw_o }
    .message = encode_json(bw_o)
  } else {
    if bw_drop_f { .message = replace(to_string(.message) ?? "", r' f_[a-z0-9_]+=\\S*', "") }
    if bw_drop_s { .message = replace(to_string(.message) ?? "", r' (?:db|cache)_(?:n|us)=\\S*', "") }
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
  return lines.join("\n") + "\n";
}

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

const TAGS = {
  duration: ["service", "dir", "via", "method", "op", "peer", "outcome", "status_class"],
  started: ["service", "dir", "via"],
  store: ["service", "via", "method", "op"],
} as const;

function tagsYaml(keys: readonly string[], indent: number, extra: Record<string, string> = {}): string {
  const pad = " ".repeat(indent);
  const rows = keys.map((k) => `${pad}${k}: "{{ bw_m.${k} }}"`);
  for (const [k, v] of Object.entries(extra)) rows.push(`${pad}${k}: ${v}`);
  return rows.join("\n");
}

/** The metric transforms shared by both collectors (design 5.3). */
export function metricTransformsYaml(): string {
  const storeMetric = (name: MetricName, field: string, store: string): string => `      - type: counter
        field: bw_m.${field}
        increment_by_value: true
        name: ${name}
        tags:
${tagsYaml(TAGS.store, 10, { store })}`;
  return `  bw_metric_prep:
    type: remap
    inputs: [bw_controls]
    drop_on_abort: true
    source: |
${inlineVrl(METRIC_PREP_VRL, 6)}

  bw_hop_route:
    type: route
    inputs: [bw_metric_prep]
    route:
      ends: '(.bw_hk == "in_end" || .bw_hk == "out_end") && exists(.bw_m.duration_s)'
      starts: '.bw_hk == "in" || .bw_hk == "out"'
      stores: '.bw_m.stores == true'

  bw_hop_duration:
    type: log_to_metric
    inputs: [bw_hop_route.ends]
    metrics:
      - type: histogram
        field: bw_m.duration_s
        name: ${MetricName.Duration}
        tags:
${tagsYaml(TAGS.duration, 10)}

  bw_hop_started:
    type: log_to_metric
    inputs: [bw_hop_route.starts]
    metrics:
      - type: counter
        field: bw_hk
        name: ${MetricName.Started}
        tags:
${tagsYaml(TAGS.started, 10)}

  bw_hop_store:
    type: log_to_metric
    inputs: [bw_hop_route.stores]
    metrics:
${storeMetric(MetricName.StoreSeconds, "db_s", "db")}
${storeMetric(MetricName.StoreSeconds, "cache_s", "cache")}
${storeMetric(MetricName.StoreCalls, "db_n", "db")}
${storeMetric(MetricName.StoreCalls, "cache_n", "cache")}

  bw_hop_cardinality:
    type: tag_cardinality_limit
    inputs: [bw_hop_duration, bw_hop_started, bw_hop_store]
    mode: exact
    value_limit: ${LABEL_VALUE_LIMIT}
    limit_exceeded_action: drop_tag
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
# backwork collector. Tails EVERY container on the host's stdout/stderr,
# derives a friendly service name, normalises the level, detects Correlator
# hop records and link lines (kind="hop"), applies the sensitive-data filter,
# ships to Loki, and exposes hop metrics + its own metrics for VM.
# The host's own telemetry belongs to the platform org: no switches here.
data_dir: /vector-data

sources:
  docker:
    type: docker_logs
    exclude_containers:
      - vector            # don't tail ourselves

  vector_metrics:
    type: internal_metrics

transforms:
  bw_normalize:
    type: remap
    inputs: [docker]
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
sinks:
  loki:
    type: loki
    inputs: [bw_controls]
    endpoint: http://loki:3100
    encoding:
      codec: json
    labels:
      service: "{{ service }}"
      level: "{{ level }}"
      kind: "{{ kind }}"
    out_of_order_action: accept
    remove_label_fields: false

  prometheus:
    type: prometheus_exporter
    inputs: [vector_metrics, bw_hop_cardinality]
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
  bw_normalize:
    type: remap
    inputs: [docker, pm2]
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
