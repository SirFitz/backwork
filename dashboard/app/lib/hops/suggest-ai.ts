/**
 * The AI write-up, pure half (BAC-93). It builds what would be sent to a model for one statement
 * shape and decides when an earlier answer can be reused. It is SWITCHED OFF: nothing here (or in
 * `suggest-ai.server.ts`) runs unless an organisation turns the switch on, sets a monthly cap above
 * zero and the server has a key. None of those holds today, so no call is ever made.
 *
 * The payload holds the shape (values already `?`), its figures, the observed schema around the
 * tables it touches (names and use counts) and the rule hits. It holds no value, no statement text
 * as recorded, no request or merchant identifier. `buildAiPayload` refuses a shape that still
 * contains a literal.
 */
import { tableOf, relationsOf, columnsByUse, type ObservedSchema } from "./observed-schema";
import { parseShape } from "./sql-parse";
import type { Suggestion } from "./suggest";
import { shapeId, statementShape } from "./stmt-shape";

/** What an attempt to write up a shape came to. */
export const AiStatus = {
  /** The organisation's switch is off (the default): nothing was sent. */
  Off: "off",
  /** No API key on this server: nothing was sent. */
  NoKey: "no_key",
  /** The monthly cap is zero or used up: nothing was sent. */
  OverCap: "over_cap",
  /** An answer (new or kept). */
  Answered: "answered",
  /** The model call failed. */
  Failed: "failed",
} as const;
export type AiStatus = (typeof AiStatus)[keyof typeof AiStatus];

/** Per-organisation settings. Off, with a cap of zero, until someone turns them on. */
export interface AiSettings {
  enabled: boolean;
  /** Write-ups per calendar month (UTC); 0 allows none. */
  monthlyCap: number;
  /** Write-ups made in `month`. */
  used: number;
  /** `YYYY-MM` the count belongs to. */
  month: string;
}

export const AI_DEFAULT_SETTINGS: AiSettings = { enabled: false, monthlyCap: 0, used: 0, month: "" };

/** The figures a shape is written up with. */
export interface AiFigures {
  calls: number;
  totalS: number;
  p95S: number | null;
  shareOfDb: number;
}

export interface AiInput {
  /** Any statement text: it is turned into its shape here. */
  statement: string;
  figures: AiFigures;
  schema: ObservedSchema;
  hits: readonly Suggestion[];
}

export interface AiPayload {
  model: string;
  system: string;
  /** The user message: the JSON of `facts`. */
  user: string;
  facts: AiFacts;
}

export interface AiFacts {
  shape: string;
  figures: AiFigures;
  tables: Array<{ name: string; reads: number; writes: number; columns: Array<{ name: string; where: number; join: number; orderBy: number; groupBy: number }> }>;
  relations: Array<{ from: string; to: string; calls: number }>;
  ruleHits: Array<{ kind: string; summary: string; evidence: string[]; sketch: string | null }>;
}

export const AI_SYSTEM_PROMPT =
  "You help a developer understand one database query. You are given its shape (values removed), figures from production, " +
  "the tables and columns it touches as seen in other queries, and hints a rule engine already made. Say in plain words, in at most " +
  "120 words, why it is probably slow and the one change most likely to help. Use hedged wording (likely, consider). Never invent " +
  "table or column names that are not in the facts. Do not ask for data.";

/** Columns listed per table. */
export const AI_MAX_COLUMNS = 12;
/** Tables listed: the shape's own and the ones a relation joins them to. */
export const AI_MAX_TABLES = 6;

export class AiPayloadError extends Error {}

/** The shape must carry no value: no quote, no placeholder number, nothing `statementShape` would still change. */
export function assertShapeOnly(shape: string): void {
  if (shape.includes("'") || shape.includes('"') || statementShape(shape) !== shape) {
    throw new AiPayloadError("The statement still holds a value; refusing to build a payload from it.");
  }
}

/** Everything a model would see for one shape. Throws `AiPayloadError` if a value would be in it. */
export function buildAiPayload(input: AiInput, model: string): AiPayload {
  const shape = statementShape(input.statement);
  assertShapeOnly(shape);
  const parsed = parseShape(shape);
  const own = parsed?.tables.map((t) => t.name) ?? [];
  const names = [...own];
  for (const t of own) {
    for (const r of relationsOf(input.schema, t)) {
      for (const other of [r.from.table, r.to.table]) if (!names.includes(other)) names.push(other);
    }
  }
  const tables = names
    .slice(0, AI_MAX_TABLES)
    .map((n) => tableOf(input.schema, n))
    .filter((t): t is NonNullable<typeof t> => t !== null)
    .map((t) => ({
      name: t.name,
      reads: t.reads,
      writes: t.writes,
      columns: columnsByUse(t).slice(0, AI_MAX_COLUMNS).map((c) => ({ name: c.name, where: c.use.where, join: c.use.join, orderBy: c.use.orderBy, groupBy: c.use.groupBy })),
    }));
  const relations = input.schema.relations
    .filter((r) => names.includes(r.from.table) && names.includes(r.to.table))
    .slice(0, 8)
    .map((r) => ({ from: `${r.from.table}.${r.from.column}`, to: `${r.to.table}.${r.to.column}`, calls: r.calls }));
  const facts: AiFacts = {
    shape,
    figures: input.figures,
    tables,
    relations,
    ruleHits: input.hits.map((h) => ({ kind: h.kind, summary: h.summary, evidence: h.evidence, sketch: h.sketch })),
  };
  return { model, system: AI_SYSTEM_PROMPT, user: JSON.stringify(facts), facts };
}

/** Round to a power of two: figures that move a little keep one bucket, so an answer is reused. */
function bucket(n: number): number {
  return n <= 0 ? 0 : 2 ** Math.round(Math.log2(n));
}

/** The figures reduced to the buckets an answer stays valid for. */
export function figuresBucket(f: AiFigures): string {
  const share = Math.round(f.shareOfDb * 10) * 10;
  return `c${bucket(f.calls)}-t${bucket(f.totalS)}-p${f.p95S === null ? "x" : bucket(f.p95S * 1000)}-s${share}`;
}

/** One answer per statement shape and figures bucket. */
export function answerKey(statement: string, figures: AiFigures): string {
  return `${shapeId(statementShape(statement))}:${figuresBucket(figures)}`;
}

/** `YYYY-MM` (UTC) of a time. */
export function monthOf(ms: number): string {
  return new Date(ms).toISOString().slice(0, 7);
}

/** The settings as of `now`: a count from an earlier month is zero. */
export function settingsAt(s: AiSettings, now: number): AiSettings {
  return s.month === monthOf(now) ? s : { ...s, used: 0, month: monthOf(now) };
}

/** True when another write-up fits in the month's cap. */
export function withinCap(s: AiSettings): boolean {
  return s.monthlyCap > 0 && s.used < s.monthlyCap;
}

/** The sentence the Settings card and the Slow queries row show. */
export function aiStatusText(s: AiSettings, keyConfigured: boolean): string {
  if (!s.enabled) return "AI write-ups are switched off until Romario approves the cost. Nothing is sent to a model.";
  if (!keyConfigured) return "AI write-ups are on, but this server has no model key, so nothing is sent.";
  if (s.monthlyCap <= 0) return "AI write-ups are on with a monthly cap of 0, so nothing is sent.";
  return `AI write-ups are on: ${s.used} of ${s.monthlyCap} used this month.`;
}
