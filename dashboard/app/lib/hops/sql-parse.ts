/**
 * A tolerant reader of statement shapes (BAC-93). A shape (`statementShape`) is lower case, with
 * values replaced by `?`, so this reads structure only: the tables a statement touches and which
 * columns it filters on, joins on, orders by and groups by. It never sees a value.
 *
 * It is deliberately conservative: a statement with a subquery, a CTE or anything it cannot read
 * comes back with `complex` set (or null), and the suggestion rules then stay silent rather than
 * guess. Pure, so it runs in the browser on the request view and on the server over Loki rows.
 */

/** The statement's command. */
export const SqlVerb = { Select: "select", Insert: "insert", Update: "update", Delete: "delete" } as const;
export type SqlVerb = (typeof SqlVerb)[keyof typeof SqlVerb];

/** What a WHERE predicate asks of its column. */
export const PredicateOp = {
  /** `= ?`, `in (?)`, `= any(?)`: a point or list lookup (an index serves these first). */
  Equal: "equal",
  /** `<`, `>`, `between`: a range. */
  Range: "range",
  /** `like`, `ilike`. */
  Like: "like",
  /** `is null`, `is not null`. */
  Null: "null",
} as const;
export type PredicateOp = (typeof PredicateOp)[keyof typeof PredicateOp];

/** A column, with the real table when it could be resolved (an alias is followed to its table). */
export interface ColumnRef {
  table: string | null;
  column: string;
}

export interface Predicate {
  column: ColumnRef;
  op: PredicateOp;
  /** The function wrapped around the column (`lower(username) = ?`), null for the bare column. */
  fn: string | null;
  /** The predicate sits in an OR branch: an index may not serve it the same way. */
  inOr: boolean;
}

/** `a.x = b.y`: two columns of different tables compared, from JOIN ... ON or WHERE. */
export interface JoinLink {
  left: ColumnRef;
  right: ColumnRef;
}

export interface TableRef {
  name: string;
  alias: string;
}

export interface ParsedStatement {
  verb: SqlVerb;
  /** The tables in statement order; the first is the driving table. */
  tables: TableRef[];
  where: Predicate[];
  joins: JoinLink[];
  orderBy: ColumnRef[];
  groupBy: ColumnRef[];
  /** A subquery, CTE, UNION or similar: the parts above may be incomplete. */
  complex: boolean;
  /** The statement has a RETURNING clause (an insert or update whose result is used). */
  returning: boolean;
  /** The statement has a LIMIT. */
  limited: boolean;
}

const IDENT = "[a-z_][a-z0-9_$]*";
const CLAUSE_WORDS = ["where", "group by", "order by", "having", "limit", "offset", "returning", "for update", "for share", "union", "window"];

/** Depth-0 positions are those outside every pair of brackets. */
function depthMap(s: string): number[] {
  const out = new Array<number>(s.length);
  let d = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === ")") d = Math.max(0, d - 1);
    out[i] = d;
    if (s[i] === "(") d++;
  }
  return out;
}

/** Index of the first top-level occurrence of ` word ` (or the word at the very start), from `from`. */
function topIndex(s: string, depth: readonly number[], word: string, from: number = 0): number {
  const needle = ` ${word} `;
  let at = s.indexOf(needle, from);
  while (at >= 0) {
    if (depth[at + 1] === 0) return at + 1;
    at = s.indexOf(needle, at + 1);
  }
  // A clause word at the end of the text with nothing after it.
  return -1;
}

/** Split at top-level occurrences of any separator (a lower-case string, matched with spaces around). */
function splitTop(s: string, separators: readonly string[]): string[] {
  const depth = depthMap(s);
  const parts: string[] = [];
  let start = 0;
  let i = 0;
  while (i < s.length) {
    let hit: string | null = null;
    if (depth[i] === 0) {
      for (const sep of separators) {
        if (sep === ",") {
          if (s[i] === ",") { hit = sep; break; }
        } else if (s.startsWith(` ${sep} `, i) && depth[i + 1] === 0) {
          hit = ` ${sep} `;
          break;
        }
      }
    }
    if (hit) {
      parts.push(s.slice(start, i));
      i += hit.length;
      start = i;
    } else i++;
  }
  parts.push(s.slice(start));
  return parts.map((p) => p.trim()).filter((p) => p.length > 0);
}

function unwrap(s: string): string {
  let t = s.trim();
  while (t.startsWith("(") && t.endsWith(")")) {
    const d = depthMap(t);
    // The opening bracket closes only at the very end.
    let closesEarly = false;
    for (let i = 1; i < t.length - 1; i++) if (d[i] === 0) { closesEarly = true; break; }
    if (closesEarly) break;
    t = t.slice(1, -1).trim();
  }
  return t;
}

const VALUE = /^(?:\?|\(\?\)|any\(\?\)|all\(\?\)|\?::\w+|\(\?\)::\w+)$/;
const COLUMN = new RegExp(`^(?:(${IDENT})\\.)?(${IDENT})$`);
const PREDICATE = new RegExp(
  `^(?:(${IDENT})\\()?\\s*(?:(${IDENT})\\.)?(${IDENT})(?:::\\w+)?\\s*\\)?(?:::\\w+)?\\s*(<=|>=|<>|!=|=|<|>|not in|in|not like|like|not ilike|ilike|is not|is|not between|between)\\s*(.*)$`,
);

const OP_OF: Record<string, PredicateOp> = {
  "=": PredicateOp.Equal,
  in: PredicateOp.Equal,
  "<": PredicateOp.Range,
  ">": PredicateOp.Range,
  "<=": PredicateOp.Range,
  ">=": PredicateOp.Range,
  between: PredicateOp.Range,
  like: PredicateOp.Like,
  ilike: PredicateOp.Like,
  is: PredicateOp.Null,
  "is not": PredicateOp.Null,
};

interface Scope {
  /** Alias or table name -> real table. */
  byName: Map<string, string>;
  only: string | null;
}

function resolve(scope: Scope, qualifier: string | undefined, column: string): ColumnRef {
  if (qualifier) return { table: scope.byName.get(qualifier) ?? null, column };
  return { table: scope.only, column };
}

function conditions(text: string, scope: Scope, preds: Predicate[], joins: JoinLink[], inOr: boolean): void {
  const t = unwrap(text);
  const ors = splitTop(t, ["or"]);
  if (ors.length > 1) {
    for (const part of ors) conditions(part, scope, preds, joins, true);
    return;
  }
  for (const piece of splitTop(t, ["and"])) {
    const u = unwrap(piece);
    if (u !== piece && (splitTop(u, ["and"]).length > 1 || splitTop(u, ["or"]).length > 1)) {
      conditions(u, scope, preds, joins, inOr);
      continue;
    }
    // `between ? and ?` was split at its `and`: a lone `?` left over is the second half.
    if (VALUE.test(u)) continue;
    const m = PREDICATE.exec(u.replace(/^not\s+/, ""));
    if (!m) continue;
    const [, fn, qualifier, column, opText, rest] = m;
    const op = OP_OF[opText];
    const right = rest.trim();
    if (op === undefined) continue;
    const rc = COLUMN.exec(right);
    if (rc && opText === "=" && !fn) {
      const left = resolve(scope, qualifier, column);
      const other = resolve(scope, rc[1], rc[2]);
      joins.push({ left, right: other });
      continue;
    }
    if (op === PredicateOp.Null || VALUE.test(right) || right === "" || /^\(\?\)$/.test(right) || /^\?/.test(right)) {
      preds.push({ column: resolve(scope, qualifier, column), op, fn: fn ?? null, inOr });
    }
  }
}

function columnList(text: string, scope: Scope): ColumnRef[] {
  const out: ColumnRef[] = [];
  for (const item of splitTop(text, [","])) {
    const m = new RegExp(`^(?:(${IDENT})\\.)?(${IDENT})(?:\\s+(?:asc|desc))?(?:\\s+nulls\\s+(?:first|last))?$`).exec(item);
    if (m) out.push(resolve(scope, m[1], m[2]));
  }
  return out;
}

function realName(raw: string): string {
  const parts = raw.split(".");
  return parts[parts.length - 1];
}

/** Read one shape; null when it is not a select, insert, update or delete. */
export function parseShape(shape: string): ParsedStatement | null {
  const s = shape.trim().toLowerCase();
  const verbMatch = /^(select|insert|update|delete)\b/.exec(s);
  if (!verbMatch) return null;
  const verb = verbMatch[1] as SqlVerb;
  const depth = depthMap(s);
  const complex = /\(\s*select\b/.test(s) || /\bunion\b/.test(s) || /^with\b/.test(s);
  const first = (words: readonly string[], from: number): number => {
    let best = -1;
    for (const w of words) {
      const at = topIndex(s, depth, w, from);
      if (at >= 0 && (best < 0 || at < best)) best = at;
    }
    return best;
  };

  // Where each clause begins, in text order.
  const marks: Array<{ word: string; at: number }> = [];
  for (const w of CLAUSE_WORDS) {
    const at = topIndex(s, depth, w);
    if (at >= 0) marks.push({ word: w, at });
  }
  marks.sort((a, b) => a.at - b.at);
  const clause = (word: string): string | null => {
    const i = marks.findIndex((m) => m.word === word);
    if (i < 0) return null;
    const start = marks[i].at + word.length;
    const end = i + 1 < marks.length ? marks[i + 1].at : s.length;
    return s.slice(start, end).trim();
  };

  // Tables.
  const onTexts: string[] = [];
  let fromText: string | null = null;
  if (verb === SqlVerb.Select || verb === SqlVerb.Delete) {
    const f = topIndex(s, depth, "from");
    if (f >= 0) {
      const end = first(CLAUSE_WORDS, f + 4);
      fromText = s.slice(f + 4, end >= 0 ? end : s.length).trim();
    }
  } else if (verb === SqlVerb.Update) {
    const end = first(["set"], 0);
    fromText = s.slice("update".length, end >= 0 ? end : s.length).trim();
  } else {
    const m = new RegExp(`^insert\\s+into\\s+(${IDENT}(?:\\.${IDENT})*)`).exec(s);
    if (m) fromText = m[1];
  }
  const tables: TableRef[] = [];
  if (fromText) {
    const items = splitTop(fromText, [",", "join", "inner join", "left join", "right join", "full join", "cross join", "left outer join", "right outer join", "full outer join"]);
    for (const item of items) {
      const [head, ...onParts] = splitTop(item, ["on"]);
      if (onParts.length) onTexts.push(onParts.join(" and "));
      const m = new RegExp(`^(${IDENT}(?:\\.${IDENT})*)(?:\\s+(?:as\\s+)?(${IDENT}))?$`).exec(head);
      if (!m) continue;
      const name = realName(m[1]);
      tables.push({ name, alias: m[2] && !["on", "where", "set", "values"].includes(m[2]) ? m[2] : name });
    }
  }
  const byName = new Map<string, string>();
  for (const t of tables) {
    byName.set(t.alias, t.name);
    byName.set(t.name, t.name);
  }
  const scope: Scope = { byName, only: tables.length === 1 ? tables[0].name : null };

  const where: Predicate[] = [];
  const joins: JoinLink[] = [];
  for (const on of onTexts) conditions(on, scope, where, joins, false);
  const whereText = clause("where");
  if (whereText) conditions(whereText, scope, where, joins, false);
  const orderText = clause("order by");
  const groupText = clause("group by");
  return {
    verb,
    tables,
    where,
    joins,
    orderBy: orderText ? columnList(orderText, scope) : [],
    groupBy: groupText ? columnList(groupText, scope) : [],
    complex,
    returning: marks.some((m) => m.word === "returning"),
    limited: marks.some((m) => m.word === "limit"),
  };
}

/** The distinct, resolved column names the statement filters with `=`, `in` or a lookup, in order. */
export function equalityColumns(p: ParsedStatement, table: string): string[] {
  const out: string[] = [];
  for (const w of p.where) {
    if (w.op !== PredicateOp.Equal || w.inOr || w.fn !== null || w.column.table !== table) continue;
    if (!out.includes(w.column.column)) out.push(w.column.column);
  }
  return out;
}
