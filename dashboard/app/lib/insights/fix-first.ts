// Insights > Fix first (BAC-74, insights plan 07). Pure: the item types, the ranking and the copy
// of the one list that puts routes, slow queries, repeated queries and regressions side by side
// in a common unit (seconds in the window). The sources are read in `fix-first.server.ts`; this
// module never imports a `.server` module, so the page uses it in the browser too.

import { fmtUs } from "~/lib/hops/time-format";
import { shapeLabel } from "~/lib/hops/stmt-shape";
import { CompareVerdict, type CompareRow } from "~/lib/hops/compare";
import type { QueryRow } from "~/lib/hops/slow-queries";

/** What an item on the list is. */
export const FixKind = { Route: "route", Query: "query", Repeat: "repeat", Regression: "regression" } as const;
export type FixKind = (typeof FixKind)[keyof typeof FixKind];
export const FIX_KINDS: readonly FixKind[] = Object.values(FixKind);

export function isFixKind(v: unknown): v is FixKind {
  return typeof v === "string" && (FIX_KINDS as readonly string[]).includes(v);
}

/** Chip text of each kind (singular) and filter text (plural). */
export const FIX_KIND_LABEL: Record<FixKind, string> = {
  [FixKind.Route]: "Route",
  [FixKind.Query]: "Query",
  [FixKind.Repeat]: "Repeat",
  [FixKind.Regression]: "Regression",
};
export const FIX_KIND_FILTER_LABEL: Record<FixKind, string> = {
  [FixKind.Route]: "Routes",
  [FixKind.Query]: "Queries",
  [FixKind.Repeat]: "Repeats",
  [FixKind.Regression]: "Regressions",
};

/** The windows the list offers. */
export const FixWindow = { H1: "1h", H6: "6h" } as const;
export type FixWindow = (typeof FixWindow)[keyof typeof FixWindow];
export const FIX_WINDOWS: readonly FixWindow[] = Object.values(FixWindow);
export const DEFAULT_FIX_WINDOW: FixWindow = FixWindow.H1;

export function isFixWindow(v: unknown): v is FixWindow {
  return typeof v === "string" && (FIX_WINDOWS as readonly string[]).includes(v);
}

/** Length of each window in milliseconds. */
export const FIX_WINDOW_MS: Record<FixWindow, number> = { [FixWindow.H1]: 3_600_000, [FixWindow.H6]: 6 * 3_600_000 };
export const FIX_WINDOW_LABEL: Record<FixWindow, string> = { [FixWindow.H1]: "1 h", [FixWindow.H6]: "6 h" };
export const FIX_WINDOW_PHRASE: Record<FixWindow, string> = { [FixWindow.H1]: "last hour", [FixWindow.H6]: "last 6 hours" };

/** How a source of the list fared. */
export const SourceState = { Ok: "ok", Unavailable: "unavailable", Off: "off" } as const;
export type SourceState = (typeof SourceState)[keyof typeof SourceState];

export const ItemTone = { Neutral: "neutral", Warn: "warn" } as const;
export type ItemTone = (typeof ItemTone)[keyof typeof ItemTone];

/** A list younger than this is served without asking the sources again (1 minute); older ones
 *  carry a "from N minutes ago" note. */
export const FIX_FRESH_MS = 60_000;
/** Routes read for the list (`topk` in PromQL). */
export const FIX_ROUTE_LIMIT = 15;
/** Slow queries and repeated queries taken into the list, each. */
export const FIX_SOURCE_LIMIT = 10;
/** Rows shown at first, and added by "Show more". */
export const FIX_PAGE_ROWS = 15;
/** Rows the page can show at most (two pages). */
export const FIX_MAX_ROWS = 2 * FIX_PAGE_ROWS;
/** A route is shown in amber from this share of failed requests (0..1)... */
export const ROUTE_ERROR_WARN_SHARE = 0.05;
/** ...when it served at least this many requests in the window. */
export const ROUTE_ERROR_MIN_REQUESTS = 20;

export interface FixItem {
  /** Stable: `${kind}:${service}:${key}`. */
  id: string;
  kind: FixKind;
  /** "GET /shop", "select orders", "select plans, 14 times per request". */
  title: string;
  /** The title is a statement (shown in mono). */
  mono: boolean;
  /** Full text for the hover title (the statement shape, or the title). */
  detail: string;
  service: string;
  /** Seconds in the window the item accounts for (spent, could be saved, or added). */
  impactS: number;
  /** "1 m 24 s of request time in the last hour" | "could save 38.0 ms" | "added 12.00 s". */
  /** For regressions the extra time: requests x (mean now - mean last week). */
  impactLabel: string;
  /** The figure alone, for narrow screens: "1 m 24 s", "save 38.0 ms", "+12.00 s". */
  impactShort: string;
  /** One clause: "71% of its time is database and cache, p95 740 ms". */
  why: string;
  /** Where to look, filters applied. */
  href: string;
  /** Amber only for regressions and error-heavy routes; never red. */
  tone: ItemTone;
}

/** One route's figures over the window (`routesByTotalTime`). */
export interface FixRouteInput {
  service: string;
  method: string;
  op: string;
  /** Seconds the route's requests took in all. */
  totalS: number;
  requests: number;
  failed: number;
  /** Seconds, null when unknown. */
  p95S: number | null;
  /** Share of its time in databases and caches (0..1), null when unknown. */
  storeShare: number | null;
}

/** One repeated query (`RepeatRow` of the repeats scan). */
export interface FixRepeatInput {
  shapeId: string;
  shape: string;
  label: string;
  service: string;
  table: string | null;
  requests: number;
  medianRepeats: number;
  sequentialRequests: number;
  wastedUs: number;
}

/** One service against last week, with the time its requests took in both windows. */
export interface FixRegressionInput {
  row: CompareRow;
  /** Seconds the service's requests took in this window, null when unknown. */
  totalNowS: number | null;
  /** Seconds they took the same hours last week, null when unknown. */
  totalBeforeS: number | null;
}

export interface FixInputs {
  window: FixWindow;
  /** null: the source is unavailable or off. */
  routes: readonly FixRouteInput[] | null;
  queries: readonly QueryRow[] | null;
  repeats: readonly FixRepeatInput[] | null;
  /** The repeats scan hit its record cap: its savings are a floor. */
  repeatsSampled: boolean;
  regressions: readonly FixRegressionInput[] | null;
}

function seconds(s: number): string {
  return fmtUs(Math.max(0, s) * 1e6);
}

function ms(s: number): string {
  return fmtUs(s * 1e6);
}

function pct(share: number): string {
  return `${Math.round(share * 100)}%`;
}

function count(n: number): string {
  return Math.round(n).toLocaleString("en-GB");
}

function routeTitle(method: string, op: string): string {
  return method ? `${method} ${op}` : op;
}

/** "select orders": the statement's verb and table, else the shortened shape. */
export function queryTitle(shape: string, table: string | null): string {
  const verb = /^\s*(\w+)/.exec(shape)?.[1];
  return verb && table ? `${verb} ${table}` : shapeLabel(shape);
}

function query(params: Record<string, string | null>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) p.set(k, v);
  const q = p.toString();
  return q ? `?${q}` : "";
}

export function routeItem(r: FixRouteInput, window: FixWindow): FixItem {
  const title = routeTitle(r.method, r.op);
  const errorShare = r.requests > 0 ? r.failed / r.requests : 0;
  const errorHeavy = r.requests >= ROUTE_ERROR_MIN_REQUESTS && errorShare >= ROUTE_ERROR_WARN_SHARE;
  const parts: string[] = [];
  if (errorHeavy) parts.push(`${pct(errorShare)} of its requests failed`);
  if (r.storeShare !== null) {
    parts.push(r.storeShare > 1 ? "its database and cache calls overlap, adding up to more than its own time" : `${pct(r.storeShare)} of its time is database and cache`);
  }
  if (r.p95S !== null) parts.push(`p95 ${ms(r.p95S)}`);
  parts.push(`${count(r.requests)} ${r.requests === 1 ? "request" : "requests"}`);
  return {
    id: `${FixKind.Route}:${r.service}:${r.method} ${r.op}`,
    kind: FixKind.Route,
    title,
    mono: false,
    detail: title,
    service: r.service,
    impactS: r.totalS,
    impactLabel: `${seconds(r.totalS)} of request time in the ${FIX_WINDOW_PHRASE[window]}`,
    impactShort: seconds(r.totalS),
    why: parts.join(", "),
    href: `/requests${query({ service: r.service, method: r.method || null, route: r.op, range: window })}`,
    tone: errorHeavy ? ItemTone.Warn : ItemTone.Neutral,
  };
}

export function queryItem(q: QueryRow, window: FixWindow): FixItem {
  const parts = [`${count(q.calls)} ${q.calls === 1 ? "call" : "calls"}`];
  if (q.p95S !== null) parts.push(`p95 ${q.p95Approx ? "about " : ""}${ms(q.p95S)}`);
  parts.push(`${pct(q.shareOfDb)} of the service's database time`);
  return {
    id: `${FixKind.Query}:${q.service}:${q.shapeId}`,
    kind: FixKind.Query,
    title: queryTitle(q.shape, q.table),
    mono: true,
    detail: q.shape,
    service: q.service,
    impactS: q.totalS,
    impactLabel: `${seconds(q.totalS)} in this query in the ${FIX_WINDOW_PHRASE[window]}`,
    impactShort: seconds(q.totalS),
    why: parts.join(", "),
    href: `/insights/queries${query({ window: window === FixWindow.H1 ? null : window, service: q.service, open: `${q.service}:${q.shapeId}` })}`,
    tone: ItemTone.Neutral,
  };
}

function repeatCount(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

export function repeatItem(r: FixRepeatInput, window: FixWindow, sampled: boolean): FixItem {
  const savedS = r.wastedUs / 1e6;
  const floor = sampled ? "at least " : "";
  const how = r.sequentialRequests === r.requests ? "one after another" : r.sequentialRequests === 0 ? "together" : `one after another in ${r.sequentialRequests} of them`;
  return {
    id: `${FixKind.Repeat}:${r.service}:${r.shapeId}:${r.table ?? ""}`,
    kind: FixKind.Repeat,
    title: `${r.label}, ${repeatCount(r.medianRepeats)} times per request`,
    mono: true,
    detail: r.shape,
    service: r.service,
    impactS: savedS,
    impactLabel: `could save ${floor}${seconds(savedS)} in the ${FIX_WINDOW_PHRASE[window]}`,
    impactShort: `save ${seconds(savedS)}`,
    why: `repeated in ${count(r.requests)} ${r.requests === 1 ? "request" : "requests"}, ${how}${sampled ? " (sampled)" : ""}`,
    href: "/insights/repeats",
    tone: ItemTone.Neutral,
  };
}

/**
 * Extra seconds against last week: this window's time minus last week's average request time
 * times this window's requests, i.e. requests x (mean now - mean then), never below zero. Zero
 * when either total is unknown or last week had no requests. (A p95 rise times requests, the
 * plan's first idea, overstates it: on the fixture it came out above the service's whole time.)
 */
export function regressionImpactS(input: FixRegressionInput): number {
  const { row, totalNowS, totalBeforeS } = input;
  if (totalNowS === null || totalBeforeS === null || row.requestsBefore <= 0) return 0;
  return Math.max(0, totalNowS - totalBeforeS * (row.requestsNow / row.requestsBefore));
}

export function regressionItem(input: FixRegressionInput, window: FixWindow): FixItem {
  const r = input.row;
  const slower = r.verdict === CompareVerdict.Slower;
  const impactS = regressionImpactS(input);
  const parts: string[] = [];
  if (r.now.p95 !== null) {
    const ratio = r.p95Ratio !== null ? `, ${r.p95Ratio >= 10 ? Math.round(r.p95Ratio) : r.p95Ratio.toFixed(1)}x last week` : "";
    parts.push(`p95 ${ms(r.now.p95)}${ratio}`);
  }
  if (!slower && r.before) parts.push(`${pct(r.now.errorShare)} failed against ${pct(r.before.errorShare)} last week`);
  return {
    id: `${FixKind.Regression}:${r.service}:${r.method ?? ""} ${r.op ?? ""}`,
    kind: FixKind.Regression,
    title: `${r.method || r.op ? routeTitle(r.method ?? "", r.op ?? "") : r.service}, ${slower ? "slower than last week" : "more errors than last week"}`,
    mono: false,
    detail: `${r.service}: ${Math.round(r.requestsNow).toLocaleString("en-GB")} requests now, ${Math.round(r.requestsBefore).toLocaleString("en-GB")} the same hours last week`,
    service: r.service,
    impactS,
    impactLabel: `added ${seconds(impactS)} in the ${FIX_WINDOW_PHRASE[window]}`,
    impactShort: `+${seconds(impactS)}`,
    why: parts.join(", "),
    href: `/performance${query({ service: r.service, compare: "1", range: window })}`,
    tone: ItemTone.Warn,
  };
}

function byImpact(a: FixItem, b: FixItem): number {
  return b.impactS - a.impactS || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/**
 * The ranked list: every source's items, largest impact first, ties by id. Each item keeps its own
 * figure (spent, could save, added): nothing is summed across kinds. Routes with no time, and
 * regressions other than Slower and MoreErrors, are left out.
 */
export function rankFixFirst(input: FixInputs, limit: number = FIX_MAX_ROWS): FixItem[] {
  const items: FixItem[] = [];
  for (const r of input.routes ?? []) if (r.totalS > 0) items.push(routeItem(r, input.window));
  for (const q of [...(input.queries ?? [])].sort((a, b) => b.totalS - a.totalS).slice(0, FIX_SOURCE_LIMIT)) {
    if (q.totalS > 0) items.push(queryItem(q, input.window));
  }
  for (const r of [...(input.repeats ?? [])].sort((a, b) => b.wastedUs - a.wastedUs).slice(0, FIX_SOURCE_LIMIT)) {
    if (r.wastedUs > 0) items.push(repeatItem(r, input.window, input.repeatsSampled));
  }
  for (const r of input.regressions ?? []) {
    if (r.row.verdict === CompareVerdict.Slower || r.row.verdict === CompareVerdict.MoreErrors) items.push(regressionItem(r, input.window));
  }
  return items.sort(byImpact).slice(0, Math.max(0, limit));
}

/** The items of one kind (or all when `kind` is null), in rank order. */
export function filterFixItems(items: readonly FixItem[], kind: FixKind | null): FixItem[] {
  return kind === null ? [...items] : items.filter((i) => i.kind === kind);
}

/** The note under the list for a source that did not contribute ("Slow queries off"). */
export const SOURCE_NAME: Record<FixKind, string> = {
  [FixKind.Route]: "Route figures",
  [FixKind.Query]: "Slow queries",
  [FixKind.Repeat]: "Repeated calls",
  [FixKind.Regression]: "Compare with last week",
};

export function sourceNote(kind: FixKind, state: SourceState): string | null {
  if (state === SourceState.Ok) return null;
  return state === SourceState.Off
    ? `${SOURCE_NAME[kind]} off: query text is switched off for this organisation.`
    : `${SOURCE_NAME[kind]} unavailable.`;
}
