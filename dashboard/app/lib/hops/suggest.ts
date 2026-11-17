/**
 * Query suggestions (BAC-93): plain hints about a request's database use, from rules over what
 * backwork recorded, never from the database itself. Each hint names the statement shape(s), the
 * figures it rests on, a change in words and, for an index or a rewrite, a short SQL sketch built
 * from the shape (names only, never a value). They are worded as hints: "likely", "consider".
 *
 * Rules over one request (the tree the request view already built):
 * - DoubleLookup: one table read twice by one hop with different predicates on the same column
 *   (`username = ?`, then `lower(username) = ?`), or the same query twice;
 * - NPlusOne: one statement shape run at least NPLUS_MIN times back to back (BAC-68's detection,
 *   with a lower floor: this is a hint, not a finding);
 * - DominantShape: one shape takes most of the request's database time: an index on the columns it
 *   filters on, with companions the observed schema says travel with them;
 * - JoinColumn: a dominant shape that joins on a column: an index on the join column;
 * - ParallelCandidate: BAC-71's chains of calls that ran one after another;
 * - AfterResponse: a slow write or notification call on the request path whose result the
 *   response probably does not need; calls already marked `handoff` show the service can do it.
 * Rules over one row of the Slow queries board (`boardSuggestion`): the same index hints from the
 * figures across requests, so they hold when the shape is not in any open request.
 *
 * Pure: no Loki, Remix or database imports. It runs in the browser on the request view and is
 * tested with plain objects.
 */
import { Repetition, callShapeKey, classifyRepetition, detectRepeats, wastedUsOf, type RepeatReport } from "./repeated";
import { parallelCandidates } from "./concurrency";
import { emptySchema, tableOf, usualCompanions, relationsOf, type ObservedSchema } from "./observed-schema";
import { PredicateOp, SqlVerb, equalityColumns, parseShape, type ParsedStatement } from "./sql-parse";
import type { QueryRow } from "./slow-queries";
import { shapeId, statementShape } from "./stmt-shape";
import { fmtUs } from "./time-format";
import { HopDir, Via, type Hop, type HopId, type RequestTree } from "./types";

// ---------------------------------------------------------------- fixed values

export const SuggestionKind = {
  DoubleLookup: "double_lookup",
  NPlusOne: "n_plus_one",
  DominantShape: "dominant_shape",
  JoinColumn: "join_column",
  ParallelCandidate: "parallel_candidate",
  AfterResponse: "after_response",
} as const;
export type SuggestionKind = (typeof SuggestionKind)[keyof typeof SuggestionKind];
export const SUGGESTION_KINDS: readonly SuggestionKind[] = Object.values(SuggestionKind);

/** How sure the wording is: an index is always a "likely", the rest are "consider". */
export const Confidence = { Likely: "likely", Consider: "consider" } as const;
export type Confidence = (typeof Confidence)[keyof typeof Confidence];

/** The shape of a call run this many times back to back is an N+1 hint (BAC-68's finding floor is 5). */
export const NPLUS_MIN = 3;
/** A shape is dominant when it takes at least this share of the request's database time... */
export const DOMINANT_SHARE = 0.5;
/** ...and at least this much, microseconds (a fast request has nothing to fix). */
export const DOMINANT_MIN_US = 10_000;
/** On the board: a shape with at least this share of its service's database time... */
export const BOARD_SHARE = 0.4;
/** ...and at least this many calls in the window... */
export const BOARD_MIN_CALLS = 20;
/** ...or a p95 at least this many times the median p95 of the service's other shapes, and at least BOARD_SLOW_P95_S. */
export const BOARD_P95_RATIO = 3;
export const BOARD_SLOW_P95_S = 0.1;
/** The board compares against at least this many other shapes. */
export const BOARD_MIN_OTHERS = 3;
/** A write or notification call costs the user from this long, microseconds. */
export const AFTER_MIN_US = 20_000;
/** Companions of a filter column: filtered together in at least this share of its filtered calls, over at least this many. */
export const COMPANION_MIN_CALLS = 10;
export const COMPANION_MIN_SHARE = 0.8;

/** Tables and peers whose names say "record this", "tell someone" or "track that". */
const BACKGROUND_NAME = /(^|[_.-])(logs?|audits?|events?|analytics?|metrics?|activit(?:y|ies)|tracking|track|notifications?|outbox|webhooks?|history|emails?|mail|sms)([_.-]|$)/;

// ---------------------------------------------------------------- types

export interface Suggestion {
  /** Stable for the same finding: kind, service, table and shape or hop. */
  id: string;
  kind: SuggestionKind;
  confidence: Confidence;
  service: string;
  table: string | null;
  /** Statement shapes it is about (empty for ParallelCandidate and AfterResponse of a non-database call). */
  shapes: string[];
  /** The hops on the request it points at, first one to scroll to; empty on the board. */
  hopIds: HopId[];
  /** One line: "merchants is looked up twice by username." */
  summary: string;
  /** Figures from the records, one per line. */
  evidence: string[];
  /** The change, in words. */
  advice: string;
  /** SQL built from the shape, names only; null when there is nothing to show. */
  sketch: string | null;
  /** Time the change could save on this request, microseconds, when it can be estimated. */
  savedUs: number | null;
  /** Time of the calls it is about, microseconds: what orders suggestions, largest first. */
  involvedUs: number;
}

/** What the rules may know beyond one request. */
export interface SuggestContext {
  schema: ObservedSchema;
  /** The Slow queries board's rows of the same environment. */
  rows: readonly QueryRow[];
}

export const NO_CONTEXT: SuggestContext = { schema: emptySchema(), rows: [] };

// ---------------------------------------------------------------- sketches

/** `create index on merchants (lower(username))` */
export function indexSketch(table: string, columns: readonly string[]): string {
  return `create index on ${table} (${columns.join(", ")})`;
}

/** The shape with its first equality filter turned into a list lookup: `where id = ?` -> `where id = any(?)`. */
export function listLookupSketch(shape: string): string | null {
  const m = /([a-z_][a-z0-9_$]*(?:\.[a-z_][a-z0-9_$]*)?) = \?/.exec(shape);
  if (!m) return null;
  return shape.replace(m[0], `${m[1]} = any(?)`);
}

/** An insert shape as one multi-row insert. */
function batchInsertSketch(shape: string): string | null {
  return /\bvalues \(\?\)/.test(shape) ? shape.replace(/\bvalues \(\?\)/, "values (?), (?), ...") : null;
}

// ---------------------------------------------------------------- reading calls

interface DbCall {
  hop: Hop;
  shape: string;
  parsed: ParsedStatement;
  us: number;
}

function onPathStore(c: Hop): boolean {
  return c.isStore && !c.handoff && !c.afterResponse && c.endMs !== null;
}

/** The on-path database calls of one inbound hop whose statement is known and readable, in start order. */
function dbCalls(parent: Hop): DbCall[] {
  const out: DbCall[] = [];
  for (const c of parent.children) {
    if (!onPathStore(c) || c.via !== Via.Db || c.stmt === null) continue;
    const shape = statementShape(c.stmt);
    const parsed = parseShape(shape);
    if (!parsed) continue;
    out.push({ hop: c, shape, parsed, us: c.durationUs ?? 0 });
  }
  return out.sort((a, b) => a.hop.startMs - b.hop.startMs);
}

function drivingTable(p: ParsedStatement): string | null {
  return p.tables[0]?.name ?? null;
}

function verbWord(c: DbCall): string {
  return `${c.parsed.verb} ${drivingTable(c.parsed) ?? ""}`.trim();
}

const pct = (x: number): string => `${Math.round(x * 100)} percent`;

/** "username" or "username and status". */
function andList(items: readonly string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

// ---------------------------------------------------------------- DoubleLookup

interface LookupKey {
  table: string;
  columns: string[];
  /** The predicates that differ: "username", "lower(username)". */
  styles: string[];
}

/** A single-table select that looks rows up by columns, or null. */
function lookupKey(c: DbCall): LookupKey | null {
  const p = c.parsed;
  if (p.verb !== SqlVerb.Select || p.complex || p.tables.length !== 1) return null;
  const table = p.tables[0].name;
  const lookups = p.where.filter((w) => !w.inOr && w.op === PredicateOp.Equal && w.column.table === table);
  if (lookups.length === 0 || p.where.some((w) => w.inOr)) return null;
  const columns = [...new Set(lookups.map((w) => w.column.column))].sort();
  const styles = lookups.map((w) => (w.fn ? `${w.fn}(${w.column.column})` : w.column.column)).sort();
  return { table, columns, styles };
}

function doubleLookups(parent: Hop, calls: readonly DbCall[]): Suggestion[] {
  const groups = new Map<string, Array<{ call: DbCall; key: LookupKey }>>();
  for (const c of calls) {
    const key = lookupKey(c);
    if (!key) continue;
    const k = `${key.table}|${key.columns.join(",")}`;
    const list = groups.get(k);
    if (list) list.push({ call: c, key });
    else groups.set(k, [{ call: c, key }]);
  }
  const out: Suggestion[] = [];
  for (const members of groups.values()) {
    if (members.length < 2) continue;
    const shapes = [...new Set(members.map((m) => m.call.shape))];
    // Many of one shape is the N+1 rule's; two of one shape is a repeat worth one line.
    if (shapes.length === 1 && members.length >= NPLUS_MIN) continue;
    const { table, columns } = members[0].key;
    const styles = [...new Set(members.flatMap((m) => m.key.styles))];
    const functional = styles.filter((s) => s.includes("("));
    const bare = styles.filter((s) => !s.includes("("));
    const spent = members.reduce((a, m) => a + m.call.us, 0);
    const longest = Math.max(...members.map((m) => m.call.us));
    const by = andList(columns);
    const evidence = members.map((m) => `${verbWord(m.call)} where ${m.key.styles.join(" and ")} took ${fmtUs(m.call.us)}`);
    const sameQuery = shapes.length === 1;
    let advice = sameQuery
      ? `The same query ran ${members.length} times in one request. Consider keeping the first result and using it again.`
      : `Both look ${table} up by ${by}. Consider one lookup and reuse its result for the other.`;
    let sketch: string | null = null;
    if (functional.length > 0 && bare.length > 0 && columns.length === 1) {
      advice += ` One side wraps the column in ${functional.map((f) => f.slice(0, f.indexOf("("))).join(", ")}, so an ordinary index on ${columns[0]} will not serve it: if you keep both, consider an index on ${functional[0]}.`;
      sketch = indexSketch(table, [functional[0]]);
    } else if (functional.length > 0) {
      advice += ` The column is wrapped in a function, so an index on ${functional[0]} would serve it.`;
      sketch = indexSketch(table, [functional[0]]);
    }
    out.push({
      id: `${SuggestionKind.DoubleLookup}:${parent.service}:${table}:${columns.join(",")}`,
      kind: SuggestionKind.DoubleLookup,
      confidence: Confidence.Consider,
      service: parent.service,
      table,
      shapes,
      hopIds: members.map((m) => m.call.hop.hopId),
      summary: sameQuery ? `${table} is read by ${by} ${members.length} times with the same query.` : `${table} is looked up ${members.length} times by ${by} with different predicates.`,
      evidence: [...evidence, `${fmtUs(spent)} in all`],
      advice,
      sketch,
      savedUs: Math.max(0, spent - longest),
      involvedUs: spent,
    });
  }
  return out;
}

// ---------------------------------------------------------------- NPlusOne

function nPlusOnes(parent: Hop, calls: readonly DbCall[], truncated: boolean): Suggestion[] {
  const byKey = new Map<string, DbCall[]>();
  for (const c of calls) {
    const k = callShapeKey(c.hop);
    const list = byKey.get(k);
    if (list) list.push(c);
    else byKey.set(k, [c]);
  }
  const out: Suggestion[] = [];
  for (const list of byKey.values()) {
    if (list.length < NPLUS_MIN) continue;
    const spans = list.map((c) => ({ startMs: c.hop.startMs, endMs: c.hop.endMs ?? c.hop.startMs }));
    const group = new Set(list.map((c) => c.hop));
    const others = parent.children.filter((c) => !group.has(c)).map((c) => ({ startMs: c.startMs, endMs: c.endMs ?? c.startMs }));
    if (classifyRepetition(spans, false, others) !== Repetition.Sequential) continue;
    const first = list[0];
    const table = drivingTable(first.parsed);
    const durations = list.map((c) => c.us);
    const total = durations.reduce((a, d) => a + d, 0);
    const saved = wastedUsOf(Repetition.Sequential, durations);
    const floor = truncated ? "at least " : "";
    let advice: string;
    let sketch: string | null;
    if (first.parsed.verb === SqlVerb.Insert) {
      advice = "Consider inserting the rows with one multi-row insert.";
      sketch = batchInsertSketch(first.shape);
    } else if (first.parsed.verb === SqlVerb.Select && equalityColumns(first.parsed, table ?? "").length > 0) {
      advice = "Consider one query that takes the whole list, or a join, instead of one query per row.";
      sketch = listLookupSketch(first.shape);
    } else if (equalityColumns(first.parsed, table ?? "").length > 0) {
      advice = "Consider one statement that takes the whole list instead of one per row.";
      sketch = listLookupSketch(first.shape);
    } else {
      advice = "Consider one statement for all of them.";
      sketch = null;
    }
    out.push({
      id: `${SuggestionKind.NPlusOne}:${parent.service}:${shapeId(first.shape)}`,
      kind: SuggestionKind.NPlusOne,
      confidence: Confidence.Likely,
      service: parent.service,
      table,
      shapes: [first.shape],
      hopIds: list.map((c) => c.hop.hopId),
      summary: `${verbWord(first)} ran ${floor}${list.length} times back to back.`,
      evidence: [`${fmtUs(total)} in all, ${fmtUs(Math.max(...durations))} for the slowest call`, `fetching them together could save about ${fmtUs(saved)}`],
      advice,
      sketch,
      savedUs: saved,
      involvedUs: total,
    });
  }
  return out;
}

// ---------------------------------------------------------------- indexes

/** The table and filter columns an index would serve for this statement: equality columns first, then one range column. */
interface IndexTarget {
  table: string;
  columns: string[];
  /** Index expressions for columns the statement wraps in a function: `lower(username)`. */
  expressions: string[];
}

function indexTarget(p: ParsedStatement): IndexTarget | null {
  if (p.complex) return null;
  let best: IndexTarget | null = null;
  for (const t of p.tables) {
    const eq = equalityColumns(p, t.name);
    const range = p.where.filter((w) => !w.inOr && w.column.table === t.name && w.fn === null && w.op === PredicateOp.Range).map((w) => w.column.column);
    const wrapped = p.where.filter((w) => !w.inOr && w.column.table === t.name && w.fn !== null && w.op === PredicateOp.Equal).map((w) => `${w.fn}(${w.column.column})`);
    const columns = [...eq, ...(range.length ? [range[0]] : [])].filter((c, i, a) => a.indexOf(c) === i);
    // A key lookup on `id` alone is served by the primary key.
    const onlyKey = columns.length === 1 && columns[0] === "id" && wrapped.length === 0;
    if ((columns.length === 0 && wrapped.length === 0) || onlyKey) continue;
    const score = columns.length + wrapped.length;
    if (!best || score > best.columns.length + best.expressions.length) best = { table: t.name, columns, expressions: [...new Set(wrapped)] };
  }
  return best;
}

/** The columns to index, with the observed schema's usual companions of a single filter column added. */
function indexColumns(target: IndexTarget, schema: ObservedSchema): { columns: string[]; companions: string[] } {
  const base = [...target.columns, ...target.expressions];
  const t = tableOf(schema, target.table);
  if (!t || target.expressions.length > 0 || target.columns.length !== 1) return { columns: base, companions: [] };
  const companions = usualCompanions(t, target.columns[0], COMPANION_MIN_CALLS, COMPANION_MIN_SHARE).slice(0, 2);
  return { columns: [...base, ...companions], companions };
}

function indexAdvice(table: string, cols: readonly string[], companions: readonly string[], schemaCalls: number): string {
  const idx = `(${cols.join(", ")})`;
  const extra = companions.length
    ? ` The queries seen on ${table} filter ${andList(companions)} together with ${cols[0]} in ${schemaCalls.toLocaleString("en-GB")} calls, so the index covers them as well.`
    : "";
  return `An index on ${table} ${idx} would likely help, if there is not one already.${extra}`;
}

function joinColumns(p: ParsedStatement): Array<{ table: string; column: string }> {
  const driving = p.tables[0]?.name;
  const out: Array<{ table: string; column: string }> = [];
  for (const j of p.joins) {
    for (const side of [j.left, j.right]) {
      if (!side.table || side.table === driving || side.column === "id") continue;
      if (!out.some((o) => o.table === side.table && o.column === side.column)) out.push({ table: side.table, column: side.column });
    }
  }
  return out;
}

function dominantShapes(parent: Hop, calls: readonly DbCall[], ctx: SuggestContext, taken: ReadonlySet<string>): Suggestion[] {
  const dbTotal = calls.reduce((a, c) => a + c.us, 0);
  if (dbTotal < DOMINANT_MIN_US) return [];
  const byShape = new Map<string, DbCall[]>();
  for (const c of calls) {
    const list = byShape.get(c.shape);
    if (list) list.push(c);
    else byShape.set(c.shape, [c]);
  }
  const out: Suggestion[] = [];
  for (const [shape, list] of byShape) {
    if (taken.has(shape)) continue;
    const total = list.reduce((a, c) => a + c.us, 0);
    const share = total / dbTotal;
    if (share < DOMINANT_SHARE || total < DOMINANT_MIN_US) continue;
    const first = list[0];
    const p = first.parsed;
    if (p.verb === SqlVerb.Insert) continue;
    const target = indexTarget(p);
    const joins = joinColumns(p);
    const row = ctx.rows.find((r) => r.service === parent.service && r.shape === shape) ?? null;
    const evidence = [
      `${pct(share)} of this request's database time: ${fmtUs(total)} of ${fmtUs(dbTotal)}${list.length > 1 ? `, in ${list.length} calls` : ""}`,
    ];
    if (row) {
      evidence.push(
        `across requests: ${row.calls.toLocaleString("en-GB")} calls, ${pct(row.shareOfDb)} of ${parent.service}'s database time${row.p95S !== null ? `, p95 ${row.p95Approx ? "about " : ""}${fmtUs(row.p95S * 1e6)}` : ""}`,
      );
    }
    const table = target?.table ?? drivingTable(p);
    if (target) {
      const { columns, companions } = indexColumns(target, ctx.schema);
      const t = tableOf(ctx.schema, target.table);
      out.push({
        id: `${SuggestionKind.DominantShape}:${parent.service}:${shapeId(shape)}`,
        kind: SuggestionKind.DominantShape,
        confidence: Confidence.Likely,
        service: parent.service,
        table,
        shapes: [shape],
        hopIds: list.map((c) => c.hop.hopId),
        summary: `${verbWord(first)} takes ${pct(share)} of the request's database time and filters on ${andList([...target.columns, ...target.expressions])}.`,
        evidence,
        advice: indexAdvice(target.table, columns, companions, t?.columns[target.columns[0]]?.where ?? 0),
        sketch: indexSketch(target.table, columns),
        savedUs: null,
        involvedUs: total,
      });
    }
    for (const j of joins.slice(0, 1)) {
      const rel = relationsOf(ctx.schema, j.table).find((r) => (r.from.table === j.table && r.from.column === j.column) || (r.to.table === j.table && r.to.column === j.column));
      out.push({
        id: `${SuggestionKind.JoinColumn}:${parent.service}:${shapeId(shape)}`,
        kind: SuggestionKind.JoinColumn,
        confidence: Confidence.Likely,
        service: parent.service,
        table: j.table,
        shapes: [shape],
        hopIds: list.map((c) => c.hop.hopId),
        summary: `${verbWord(first)} joins ${j.table} on ${j.column} and takes ${pct(share)} of the request's database time.`,
        evidence: rel ? [...evidence, `this join was seen in ${rel.calls.toLocaleString("en-GB")} calls`] : evidence,
        advice: `An index on ${j.table} (${j.column}) would likely help the join, if there is not one already.`,
        sketch: indexSketch(j.table, [j.column]),
        savedUs: null,
        involvedUs: total,
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------- AfterResponse

function looksBackground(h: Hop, p: ParsedStatement | null): boolean {
  if (h.isStore) {
    if (h.via !== Via.Db || !p || p.verb === SqlVerb.Select || p.returning || p.tables.length === 0) return false;
    return BACKGROUND_NAME.test(p.tables[0].name);
  }
  if (h.dir !== HopDir.Out || (h.method ?? "").toUpperCase() !== "POST") return false;
  const where = [h.peer, h.op, h.children.find((c) => c.dir === HopDir.In)?.service].filter(Boolean).join(" ").toLowerCase();
  return BACKGROUND_NAME.test(where);
}

function afterResponses(tree: RequestTree): Suggestion[] {
  const out: Suggestion[] = [];
  for (const parent of tree.hops) {
    if (parent.dir !== HopDir.In) continue;
    const alreadyBackground = parent.children.filter((c) => c.handoff).length;
    for (const c of parent.children) {
      if (c.handoff || c.afterResponse || c.endMs === null || (c.durationUs ?? 0) < AFTER_MIN_US) continue;
      const shape = c.isStore && c.via === Via.Db && c.stmt !== null ? statementShape(c.stmt) : null;
      const parsed = shape ? parseShape(shape) : null;
      if (!looksBackground(c, parsed)) continue;
      const us = c.durationUs ?? 0;
      const label = c.isStore ? `${parsed?.verb ?? "query"} ${parsed ? drivingTable(parsed) : ""}`.trim() : `${c.method ?? "call"} ${c.peer ?? c.op ?? "another service"}`;
      const evidence = [`${fmtUs(us)} on the request path`];
      if (alreadyBackground > 0) evidence.push(`${alreadyBackground} other ${alreadyBackground === 1 ? "call" : "calls"} from ${parent.service} in this request already run in the background`);
      out.push({
        id: `${SuggestionKind.AfterResponse}:${parent.service}:${shape ? shapeId(shape) : c.hopId}`,
        kind: SuggestionKind.AfterResponse,
        confidence: Confidence.Consider,
        service: parent.service,
        table: parsed ? drivingTable(parsed) : null,
        shapes: shape ? [shape] : [],
        hopIds: [c.hopId],
        summary: `${label} looks like something the response may not need to wait for.`,
        evidence,
        advice: "If the response does not use its result, consider doing it after the response is sent, or from a queue.",
        sketch: null,
        savedUs: us,
        involvedUs: us,
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------- the request's suggestions

/** The suggestions for one request, the one about the most time first. `repeats` is `detectRepeats(tree, truncated)`. */
export function requestSuggestions(
  tree: RequestTree,
  repeats: RepeatReport = detectRepeats(tree, false),
  ctx: SuggestContext = NO_CONTEXT,
): Suggestion[] {
  const out: Suggestion[] = [];
  for (const parent of tree.hops) {
    if (parent.dir !== HopDir.In) continue;
    const calls = dbCalls(parent);
    const plus = nPlusOnes(parent, calls, repeats.truncated);
    const doubles = doubleLookups(parent, calls);
    const taken = new Set<string>([...plus, ...doubles].flatMap((s) => s.shapes));
    out.push(...plus, ...doubles, ...dominantShapes(parent, calls, ctx, taken));
  }
  for (const c of parallelCandidates(tree, repeats)) {
    out.push({
      id: `${SuggestionKind.ParallelCandidate}:${c.service}:${c.hopIds[0]}`,
      kind: SuggestionKind.ParallelCandidate,
      confidence: Confidence.Consider,
      service: c.service,
      table: null,
      shapes: [],
      hopIds: c.hopIds,
      summary: `${c.hopIds.length} calls from ${c.service} ran one after another and could run together.`,
      evidence: [`${c.labels.join(", ")}`, `${fmtUs(c.serialUs)} one after another, about ${fmtUs(c.parallelUs)} together`],
      advice: `If they do not depend on each other, start them together: it could save about ${fmtUs(c.savedUs)}.`,
      sketch: null,
      savedUs: c.savedUs,
      involvedUs: c.serialUs,
    });
  }
  out.push(...afterResponses(tree));
  const seen = new Set<string>();
  return out
    .filter((s) => (seen.has(s.id) ? false : (seen.add(s.id), true)))
    .sort((a, b) => b.involvedUs - a.involvedUs || SUGGESTION_KINDS.indexOf(a.kind) - SUGGESTION_KINDS.indexOf(b.kind) || a.id.localeCompare(b.id));
}

/** Each suggestion's hops, by hop id (first suggestion wins), for marking rows. */
export function suggestionsByHop(list: readonly Suggestion[]): Map<HopId, Suggestion> {
  const out = new Map<HopId, Suggestion>();
  for (const s of list) for (const id of s.hopIds) if (!out.has(id)) out.set(id, s);
  return out;
}

// ---------------------------------------------------------------- the board

function median(xs: readonly number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * The hint for one row of the Slow queries board, from the figures across requests: the shape is
 * dominant (a large share of its service's database time over enough calls) or slow (p95 several
 * times the median of the service's other shapes). Null when it is neither, or when it has no
 * filter or join column an index could serve. `rows` are all rows of the board.
 */
export function boardSuggestion(row: QueryRow, rows: readonly QueryRow[], schema: ObservedSchema): Suggestion | null {
  const p = parseShape(row.shape);
  if (!p || p.complex || p.verb === SqlVerb.Insert) return null;
  const others = rows.filter((r) => r.service === row.service && r.shape !== row.shape && r.p95S !== null).map((r) => r.p95S as number);
  const medianP95 = others.length >= BOARD_MIN_OTHERS ? median(others) : null;
  const dominant = row.shareOfDb >= BOARD_SHARE && row.calls >= BOARD_MIN_CALLS;
  const slow = row.p95S !== null && medianP95 !== null && row.p95S >= BOARD_SLOW_P95_S && row.p95S >= BOARD_P95_RATIO * medianP95 && row.calls >= BOARD_MIN_CALLS;
  if (!dominant && !slow) return null;
  const evidence: string[] = [];
  if (dominant) evidence.push(`${pct(row.shareOfDb)} of ${row.service}'s database time over ${row.calls.toLocaleString("en-GB")} calls`);
  if (row.p95S !== null) {
    evidence.push(
      slow && medianP95 !== null
        ? `p95 ${row.p95Approx ? "about " : ""}${fmtUs(row.p95S * 1e6)}, ${Math.round(row.p95S / medianP95)} times the median p95 of the other queries (${fmtUs(medianP95 * 1e6)})`
        : `p95 ${row.p95Approx ? "about " : ""}${fmtUs(row.p95S * 1e6)}`,
    );
  }
  const target = indexTarget(p);
  if (target) {
    const { columns, companions } = indexColumns(target, schema);
    const t = tableOf(schema, target.table);
    return {
      id: `${SuggestionKind.DominantShape}:${row.service}:${row.shapeId}`,
      kind: SuggestionKind.DominantShape,
      confidence: Confidence.Likely,
      service: row.service,
      table: target.table,
      shapes: [row.shape],
      hopIds: [],
      summary: `Index ${target.table} (${columns.join(", ")}), likely`,
      evidence,
      advice: indexAdvice(target.table, columns, companions, t?.columns[target.columns[0]]?.where ?? 0),
      sketch: indexSketch(target.table, columns),
      savedUs: null,
      involvedUs: row.totalS * 1e6,
    };
  }
  const join = joinColumns(p)[0];
  if (join) {
    return {
      id: `${SuggestionKind.JoinColumn}:${row.service}:${row.shapeId}`,
      kind: SuggestionKind.JoinColumn,
      confidence: Confidence.Likely,
      service: row.service,
      table: join.table,
      shapes: [row.shape],
      hopIds: [],
      summary: `Index ${join.table} (${join.column}), likely`,
      evidence,
      advice: `An index on ${join.table} (${join.column}) would likely help the join, if there is not one already.`,
      sketch: indexSketch(join.table, [join.column]),
      savedUs: null,
      involvedUs: row.totalS * 1e6,
    };
  }
  return null;
}

/** The text a kind of suggestion is filed under, for the "why" of a count. */
export const SUGGESTION_KIND_LABEL: Record<SuggestionKind, string> = {
  [SuggestionKind.DoubleLookup]: "Looked up twice",
  [SuggestionKind.NPlusOne]: "One query per row",
  [SuggestionKind.DominantShape]: "Index",
  [SuggestionKind.JoinColumn]: "Join index",
  [SuggestionKind.ParallelCandidate]: "Could run together",
  [SuggestionKind.AfterResponse]: "Could run after the response",
};
