/**
 * Statement shapes (BAC-67 foundation): one answer to "is this the same query?" for the path view
 * grouping, the repeated-call detector, the slow queries board, alerts and the digest. Pure, so it
 * runs in the browser on the request view and on the server over Loki aggregates alike.
 *
 * A shape is the statement with its values taken out and its spelling made uniform:
 * - string literals, bare numbers and numbered placeholders (`$1`) become `?`;
 * - identifier quotes (`"plans"`, `` `plans` ``) are dropped and the text is lowercased;
 * - whitespace collapses to one space, with one spacing style around brackets, commas and
 *   comparison operators (`a=?` and `a = ?` are one shape);
 * - an `in (?, ?, ...)` or `values (?, ?), (?, ?)` list becomes one `?`: `in (?)`, `values (?)`;
 * - a trailing `;` is dropped.
 * Table and column names are kept, so two different tables never share a shape.
 */

/** Characters of a shape shown before a label is cut (list rows, alert names). */
export const SHAPE_LABEL_CHARS = 80;

const STRING_LITERAL = /'(?:[^']|'')*'/g;
const IDENT_QUOTES = /["`]/g;
const NUMBERED_PLACEHOLDER = /\$\d+/g;
const BARE_NUMBER = /(?<![\w.$])\d+(?:\.\d+)?(?![\w.])/g;
const WHITESPACE = /\s+/g;
const OPEN_BRACKET = /\(\s*/g;
const CLOSE_BRACKET = /\s*\)/g;
const COMMA = /\s*,\s*/g;
const COMPARISON = /\s*(<=|>=|<>|!=|=|<|>)\s*/g;
const IN_LIST = /\bin\s*\(\?(?:, \?)*\)/g;
const VALUES_LIST = /\bvalues\s*\(\?(?:, \?)*\)(?:, \(\?(?:, \?)*\))*/g;
const TRAILING_SEMICOLONS = /[\s;]+$/;

/** The shape of a statement (see the header): stable for one query whatever its values. */
export function statementShape(stmt: string): string {
  return stmt
    .replace(STRING_LITERAL, "?")
    .replace(IDENT_QUOTES, "")
    .toLowerCase()
    .replace(NUMBERED_PLACEHOLDER, "?")
    .replace(BARE_NUMBER, "?")
    .replace(WHITESPACE, " ")
    .replace(OPEN_BRACKET, "(")
    .replace(CLOSE_BRACKET, ")")
    .replace(COMMA, ", ")
    .replace(COMPARISON, " $1 ")
    .replace(WHITESPACE, " ")
    .replace(IN_LIST, "in (?)")
    .replace(VALUES_LIST, "values (?)")
    .replace(TRAILING_SEMICOLONS, "")
    .trim();
}

const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;
const ENCODER = new TextEncoder();

/** 8 hex characters (32-bit FNV-1a over the UTF-8 bytes): the same on client and server, for URLs
 *  and alert targets. */
export function shapeId(shape: string): string {
  let hash = FNV_OFFSET;
  for (const byte of ENCODER.encode(shape)) {
    hash ^= byte;
    hash = Math.imul(hash, FNV_PRIME) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/** The head of a shape in at most `maxChars` characters, cut at a word boundary and ending in "…"
 *  when it had to be cut. */
export function shapeLabel(shape: string, maxChars: number = SHAPE_LABEL_CHARS): string {
  if (shape.length <= maxChars) return shape;
  if (maxChars <= 1) return "…";
  const room = shape.slice(0, maxChars - 1);
  const space = room.lastIndexOf(" ");
  const head = space > 0 ? room.slice(0, space) : room;
  return `${head.trimEnd()}…`;
}
