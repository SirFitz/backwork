// The Requests page's filters, kept in the URL (BAC-90): one source of truth, so changing one
// filter keeps the others, and reload, back from a trace and a shared link restore the view.
// Pure: parsed on the server (service, range, health, env choose what is loaded) and in the
// browser (search, route, status, method, sort and "chatty only" narrow the loaded rows).
import { ENV_PARAM, isEnvSlug } from "~/lib/env";
import { HEALTH_PARAM, HealthChecks, healthChecksFrom } from "~/lib/hops/health";

/** The URL parameter of each filter. */
export const RequestParam = {
  Service: "service",
  Range: "range",
  Health: HEALTH_PARAM,
  Env: ENV_PARAM,
  Query: "q",
  Route: "route",
  Status: "status",
  Method: "method",
  Sort: "sort",
  Dir: "dir",
  Chatty: "chatty",
} as const;
export type RequestParam = (typeof RequestParam)[keyof typeof RequestParam];

/** "Load older requests" cursor: tied to one result set, never kept across a filter change. */
export const BEFORE_PARAM = "before";

/** Look-back ranges, in hours. */
export const REQUEST_RANGES = { "1h": 1, "6h": 6, "24h": 24 } as const;
export type RequestRange = keyof typeof REQUEST_RANGES;
export const DEFAULT_RANGE: RequestRange = "1h";

export function isRequestRange(v: unknown): v is RequestRange {
  return typeof v === "string" && Object.prototype.hasOwnProperty.call(REQUEST_RANGES, v);
}

export const StatusFilter = { All: "all", S2xx: "2xx", S3xx: "3xx", S4xx: "4xx", S5xx: "5xx" } as const;
export type StatusFilter = (typeof StatusFilter)[keyof typeof StatusFilter];
export const STATUS_FILTERS: readonly StatusFilter[] = Object.values(StatusFilter);

export function isStatusFilter(v: unknown): v is StatusFilter {
  return typeof v === "string" && (STATUS_FILTERS as readonly string[]).includes(v);
}

export const SortKey = { Time: "time", Status: "status", Latency: "latency", Calls: "calls" } as const;
export type SortKey = (typeof SortKey)[keyof typeof SortKey];
const SORT_KEYS: readonly SortKey[] = Object.values(SortKey);

export const SortDir = { Asc: "asc", Desc: "desc" } as const;
export type SortDir = (typeof SortDir)[keyof typeof SortDir];

export interface RequestSort {
  key: SortKey | null;
  dir: SortDir;
}

export const ALL_SERVICES = "all";
export const ALL_METHODS = "all";

export interface RequestFilters {
  service: string;
  range: RequestRange;
  health: HealthChecks;
  /** Project slug; null = the remembered or default one. */
  env: string | null;
  /** Free-text search over path, route, domain and service. */
  q: string;
  /** An exact route (from a link such as Performance's route table); wins over `q`. */
  route: string | null;
  status: StatusFilter;
  method: string;
  sort: RequestSort;
  chatty: boolean;
}

export const DEFAULT_REQUEST_FILTERS: RequestFilters = {
  service: ALL_SERVICES,
  range: DEFAULT_RANGE,
  health: HealthChecks.Hidden,
  env: null,
  q: "",
  route: null,
  status: StatusFilter.All,
  method: ALL_METHODS,
  sort: { key: null, dir: SortDir.Desc },
  chatty: false,
};

/** Values longer than this are cut: a URL is not a place for megabytes. */
const MAX_TEXT = 400;
const METHOD_RE = /^[A-Za-z]{1,16}$/;

function text(v: string | null): string {
  return (v ?? "").slice(0, MAX_TEXT);
}

/** Read every filter from the URL; unknown or malformed values fall back to the default. */
export function parseRequestFilters(params: URLSearchParams): RequestFilters {
  const d = DEFAULT_REQUEST_FILTERS;
  const service = text(params.get(RequestParam.Service)) || d.service;
  const range = params.get(RequestParam.Range);
  const env = params.get(RequestParam.Env);
  const route = params.get(RequestParam.Route);
  const status = params.get(RequestParam.Status);
  const method = params.get(RequestParam.Method);
  const sortKey = params.get(RequestParam.Sort);
  const key = SORT_KEYS.find((k) => k === sortKey) ?? null;
  return {
    service,
    range: isRequestRange(range) ? range : d.range,
    health: healthChecksFrom(params.get(RequestParam.Health)),
    env: isEnvSlug(env) ? env : null,
    q: text(params.get(RequestParam.Query)),
    route: route !== null ? text(route) : null,
    status: isStatusFilter(status) ? status : d.status,
    method: method && METHOD_RE.test(method) ? method.toUpperCase() : d.method,
    sort: { key, dir: key && params.get(RequestParam.Dir) === SortDir.Asc ? SortDir.Asc : SortDir.Desc },
    chatty: params.get(RequestParam.Chatty) === "1",
  };
}

/** Write the filters as URL parameters, defaults left out, in a fixed order. */
export function serialiseRequestFilters(f: RequestFilters): URLSearchParams {
  const p = new URLSearchParams();
  if (f.env) p.set(RequestParam.Env, f.env);
  if (f.service !== ALL_SERVICES) p.set(RequestParam.Service, f.service);
  if (f.range !== DEFAULT_RANGE) p.set(RequestParam.Range, f.range);
  if (f.health === HealthChecks.Shown) p.set(RequestParam.Health, "1");
  if (f.route !== null) p.set(RequestParam.Route, f.route);
  else if (f.q) p.set(RequestParam.Query, f.q);
  if (f.status !== StatusFilter.All) p.set(RequestParam.Status, f.status);
  if (f.method !== ALL_METHODS) p.set(RequestParam.Method, f.method);
  if (f.sort.key) {
    p.set(RequestParam.Sort, f.sort.key);
    if (f.sort.dir === SortDir.Asc) p.set(RequestParam.Dir, SortDir.Asc);
  }
  if (f.chatty) p.set(RequestParam.Chatty, "1");
  return p;
}

const KNOWN: ReadonlySet<string> = new Set<string>([...Object.values(RequestParam), BEFORE_PARAM]);

/**
 * The URL after changing some filters: every other filter is kept, the pagination cursor is
 * dropped, and parameters this page does not own (e.g. `pinned`) pass through untouched.
 */
export function withRequestFilters(current: URLSearchParams, patch: Partial<RequestFilters>): URLSearchParams {
  const next = serialiseRequestFilters({ ...parseRequestFilters(current), ...patch });
  for (const [k, v] of current) if (!KNOWN.has(k)) next.append(k, v);
  return next;
}

/** The filters that choose which rows are loaded; a change reloads the feed and resets "older". */
export function resultSetKey(f: Pick<RequestFilters, "service" | "range" | "health" | "env">): string {
  return `${f.env ?? ""}|${f.service}|${f.range}|${f.health}`;
}

/** Filters applied to the loaded rows in the browser: changing only these needs no new data. */
const CLIENT_ONLY: ReadonlySet<string> = new Set<string>([
  RequestParam.Query,
  RequestParam.Route,
  RequestParam.Status,
  RequestParam.Method,
  RequestParam.Sort,
  RequestParam.Dir,
  RequestParam.Chatty,
]);

/** True when two URLs differ only in filters the browser applies to rows it already has. */
export function onlyClientFiltersChanged(a: URLSearchParams, b: URLSearchParams): boolean {
  const keys = new Set<string>([...a.keys(), ...b.keys()]);
  let changed = false;
  for (const k of keys) {
    const same = a.getAll(k).join("\u0000") === b.getAll(k).join("\u0000");
    if (same) continue;
    if (!CLIENT_ONLY.has(k)) return false;
    changed = true;
  }
  return changed;
}
