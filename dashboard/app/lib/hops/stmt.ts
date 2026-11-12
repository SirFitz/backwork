// The statement fields of SQL hop records (spec draft 0.9, section 13.2; design 21). Pure, shared
// by the dashboard's parser and the ingest proxy, so both read a line the same way.
//
// In a plain-text record `stmt` is always the last pair and its value is everything after
// ` stmt=` to the end of the line, spaces included (spec HOP-14). It is therefore split off
// before the remaining `key=value` pairs are read: `where a = ? and status=?` stays inside it.

/** The two fields, as named in records. */
export const StatementField = {
  Table: "table",
  Stmt: "stmt",
} as const;
export type StatementField = (typeof StatementField)[keyof typeof StatementField];
export const STATEMENT_FIELDS: readonly StatementField[] = Object.values(StatementField);

/** STM-4: at most 300 bytes. */
export const MAX_STMT_BYTES = 300;
/** HOP-12, which `table` follows (STM-5). */
export const MAX_TABLE_BYTES = 200;

const MARK = " stmt=";
const LEAD = "stmt=";

/** A plain-text record split into the pairs before `stmt` and the `stmt` value (null when absent). */
export interface StatementSplit {
  head: string;
  stmt: string | null;
}

/** Split at the first ` stmt=` (or a leading `stmt=`): what follows is the statement, verbatim. */
export function splitStatement(text: string): StatementSplit {
  if (text.startsWith(LEAD)) return { head: "", stmt: text.slice(LEAD.length) };
  const at = text.indexOf(MARK);
  if (at < 0) return { head: text, stmt: null };
  return { head: text.slice(0, at), stmt: text.slice(at + MARK.length) };
}

/** STM-4: 1 to 300 bytes, every byte 0x20..0x7E. */
export function isStatement(value: unknown): value is string {
  if (typeof value !== "string" || value.length < 1 || value.length > MAX_STMT_BYTES) return false;
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c < 0x20 || c > 0x7e) return false;
  }
  return true;
}

/** HOP-12: 1 to 200 bytes, every byte 0x21..0x7E. */
export function isTableName(value: unknown): value is string {
  if (typeof value !== "string" || value.length < 1 || value.length > MAX_TABLE_BYTES) return false;
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c < 0x21 || c > 0x7e) return false;
  }
  return true;
}
