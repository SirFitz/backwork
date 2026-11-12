// How a data-store hop is named in the request view (design 21). Pure.
//
// A database row with the statement fields reads "select merchants" (command and table, or the
// command alone when there is no table) and shows its statement beside it; its host moves to the
// row detail, and to the path legend once when every such row shares it. A row without the fields
// (records written before spec 13.2, or with Query text off) and every cache row read as before:
// the command and the host.
import { Via, type Hop } from "~/lib/hops/types";

/** True when the record carried `table` or `stmt`. */
export function hasStatementFields(hop: Pick<Hop, "via" | "table" | "stmt">): boolean {
  return hop.via === Via.Db && (hop.table !== null || hop.stmt !== null);
}

/** The row label of a data-store hop. */
export function storeLabel(hop: Pick<Hop, "via" | "op" | "peer" | "table" | "stmt">): string {
  if (hasStatementFields(hop)) return [hop.op ?? "query", hop.table].filter(Boolean).join(" ");
  return `${hop.op ?? ""} ${hop.peer ?? ""}`.trim() || hop.via;
}

/** The database host every database row with statement fields shares, or null. */
export function sharedDatabaseHost(hops: ReadonlyArray<Pick<Hop, "via" | "isStore" | "peer" | "table" | "stmt">>): string | null {
  let host: string | null = null;
  let seen = false;
  for (const h of hops) {
    if (!h.isStore || h.via !== Via.Db || !hasStatementFields(h)) continue;
    if (!h.peer) return null;
    if (seen && h.peer !== host) return null;
    host = h.peer;
    seen = true;
  }
  return host;
}

/** Escapes a table name for use inside a regular expression. */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * What a database row shows beside its label. The label already names the command and the table,
 * so a statement that opens with them (`select ... from <table>`, `select <columns> from <table>`,
 * `insert into <table>`, `update <table>`, `delete from <table>`, with an optional schema and
 * quotes) is shown from just after the table: `as m0 where (m0.username = ?) limit ?`. Nothing
 * after the table shows nothing. A head that does not match (a `with` query, a subquery, no table)
 * shows the whole statement. View only: the stored statement, the hover text and the row detail
 * keep the full text.
 */
export function statementTail(hop: Pick<Hop, "via" | "table" | "stmt">): string | null {
  const stmt = hop.stmt;
  if (stmt === null) return null;
  const table = hop.table;
  if (!hasStatementFields(hop) || table === null || table === "") return stmt;
  const bare = table.replace(/^.*\./, "").replace(/^["`]|["`]$/g, "");
  const name = `(?:["\`]?[A-Za-z_][\\w$]*["\`]?\\.)?["\`]?${escapeRegExp(bare)}["\`]?`;
  const heads = [
    `^select\\s(?:(?!\\bfrom\\b)[\\s\\S])*?\\bfrom\\s+${name}`,
    `^insert\\s+into\\s+${name}`,
    `^update\\s+${name}`,
    `^delete\\s+from\\s+${name}`,
  ];
  for (const head of heads) {
    const m = new RegExp(`${head}(?=$|[\\s(),;])`, "i").exec(stmt);
    if (m) return stmt.slice(m[0].length).trim();
  }
  return stmt;
}
