/**
 * The observed schema (BAC-93): what the statements a project ran say about its database, with no
 * connection to the database itself. Built from statement shapes and their call counts:
 *
 * - the tables, with how many calls read and wrote them;
 * - per table, the columns seen in WHERE, JOIN ON, ORDER BY and GROUP BY, with the number of calls
 *   that used each one, and which pairs of columns were filtered together;
 * - the relations a join states (`orders.merchant_id = merchants.id`), with how many calls used it.
 *
 * It is a picture of use, never of structure: there are no types, keys or indexes in it, and a
 * column that no statement mentions is not in it. Pure: tested with plain rows.
 *
 * Where uploaded migrations would plug in (a later ticket): `buildObservedSchema` takes the rows
 * and returns `ObservedSchema`; a migration reader would produce the same table and column names
 * with their types and indexes, and `mergeDeclared(observed, declared)` would sit beside it. The
 * suggestion rules read only `ObservedSchema`, so they would not change.
 */
import { PredicateOp, SqlVerb, parseShape, type ColumnRef } from "./sql-parse";

/** How often one column was used, in calls. */
export interface ColumnUsage {
  where: number;
  /** Of `where`, the calls that compared it for equality or a list (`=`, `in`). */
  whereEqual: number;
  join: number;
  orderBy: number;
  groupBy: number;
}

export interface ObservedTable {
  name: string;
  /** Calls that read it (select) and that changed it (insert, update, delete). */
  reads: number;
  writes: number;
  /** Distinct statement shapes that touch it. */
  shapes: number;
  columns: Record<string, ColumnUsage>;
  /** Calls that filtered two columns together: key `a|b` with a < b. */
  filteredTogether: Record<string, number>;
}

export interface ObservedRelation {
  from: ColumnRef & { table: string };
  to: ColumnRef & { table: string };
  /** Calls whose statement joined them. */
  calls: number;
}

export interface ObservedSchema {
  tables: ObservedTable[];
  relations: ObservedRelation[];
  /** Statement shapes read, and how many were skipped because they could not be read. */
  shapesRead: number;
  shapesSkipped: number;
}

/** One statement shape and how many times it ran. */
export interface ShapeCalls {
  shape: string;
  calls: number;
}

const blank = (): ColumnUsage => ({ where: 0, whereEqual: 0, join: 0, orderBy: 0, groupBy: 0 });

/** `a|b` for a pair, in a fixed order. */
export function pairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

/** The empty schema. */
export function emptySchema(): ObservedSchema {
  return { tables: [], relations: [], shapesRead: 0, shapesSkipped: 0 };
}

/** Build the observed schema from shapes. A shape that cannot be read, or has a subquery, adds only its tables. */
export function buildObservedSchema(rows: readonly ShapeCalls[]): ObservedSchema {
  const tables = new Map<string, ObservedTable>();
  const relations = new Map<string, ObservedRelation>();
  let read = 0;
  let skipped = 0;
  const table = (name: string): ObservedTable => {
    let t = tables.get(name);
    if (!t) {
      t = { name, reads: 0, writes: 0, shapes: 0, columns: {}, filteredTogether: {} };
      tables.set(name, t);
    }
    return t;
  };
  const column = (c: ColumnRef): ColumnUsage | null => {
    if (!c.table) return null;
    const t = table(c.table);
    return (t.columns[c.column] ??= blank());
  };

  for (const { shape, calls } of rows) {
    const weight = Math.max(1, Math.round(calls));
    const p = parseShape(shape);
    if (!p) {
      skipped++;
      continue;
    }
    read++;
    const touched = new Set(p.tables.map((t) => t.name));
    for (const name of touched) {
      const t = table(name);
      t.shapes++;
      if (p.verb === SqlVerb.Select) t.reads += weight;
      else t.writes += weight;
    }
    if (p.complex) continue;
    const seen = new Map<string, Set<string>>();
    for (const w of p.where) {
      const u = column(w.column);
      if (!u || !w.column.table) continue;
      u.where += weight;
      if (w.op === PredicateOp.Equal && !w.inOr) u.whereEqual += weight;
      if (w.fn === null && !w.inOr) {
        const set = seen.get(w.column.table) ?? new Set<string>();
        set.add(w.column.column);
        seen.set(w.column.table, set);
      }
    }
    for (const [name, cols] of seen) {
      const list = [...cols].sort();
      const t = table(name);
      for (let i = 0; i < list.length; i++) {
        for (let j = i + 1; j < list.length; j++) {
          const k = pairKey(list[i], list[j]);
          t.filteredTogether[k] = (t.filteredTogether[k] ?? 0) + weight;
        }
      }
    }
    for (const j of p.joins) {
      const l = column(j.left);
      const r = column(j.right);
      if (l) l.join += weight;
      if (r) r.join += weight;
      if (!j.left.table || !j.right.table || j.left.table === j.right.table) continue;
      // The side named first is "from"; the pair is stored in one order so `a.x = b.y` and `b.y = a.x` merge.
      const [a, b] = `${j.left.table}.${j.left.column}` <= `${j.right.table}.${j.right.column}` ? [j.left, j.right] : [j.right, j.left];
      const key = `${a.table}.${a.column}=${b.table}.${b.column}`;
      const rel = relations.get(key) ?? { from: a as ObservedRelation["from"], to: b as ObservedRelation["to"], calls: 0 };
      rel.calls += weight;
      relations.set(key, rel);
    }
    for (const c of p.orderBy) {
      const u = column(c);
      if (u) u.orderBy += weight;
    }
    for (const c of p.groupBy) {
      const u = column(c);
      if (u) u.groupBy += weight;
    }
  }
  return {
    tables: [...tables.values()].sort((a, b) => b.reads + b.writes - (a.reads + a.writes) || a.name.localeCompare(b.name)),
    relations: [...relations.values()].sort((a, b) => b.calls - a.calls || `${a.from.table}${a.from.column}`.localeCompare(`${b.from.table}${b.from.column}`)),
    shapesRead: read,
    shapesSkipped: skipped,
  };
}

export function tableOf(schema: ObservedSchema, name: string): ObservedTable | null {
  return schema.tables.find((t) => t.name === name) ?? null;
}

/** A table's columns, most used first. */
export function columnsByUse(t: ObservedTable): Array<{ name: string; use: ColumnUsage; total: number }> {
  return Object.entries(t.columns)
    .map(([name, use]) => ({ name, use, total: use.where + use.join + use.orderBy + use.groupBy }))
    .sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));
}

/** Relations that involve a table. */
export function relationsOf(schema: ObservedSchema, table: string): ObservedRelation[] {
  return schema.relations.filter((r) => r.from.table === table || r.to.table === table);
}

/**
 * Columns that nearly always travel with `columns` when `table` is filtered: for each other column,
 * the share of calls that filtered every given column and also filtered it. Needs a single given
 * column (pairs only are recorded), at least `minCalls` filtered calls and `minShare` of them.
 */
export function usualCompanions(t: ObservedTable, column: string, minCalls: number, minShare: number): string[] {
  const base = t.columns[column]?.where ?? 0;
  if (base < minCalls) return [];
  const out: Array<{ name: string; n: number }> = [];
  for (const [key, n] of Object.entries(t.filteredTogether)) {
    const [a, b] = key.split("|");
    const other = a === column ? b : b === column ? a : null;
    if (other && n / base >= minShare) out.push({ name: other, n });
  }
  return out.sort((x, y) => y.n - x.n || x.name.localeCompare(y.name)).map((o) => o.name);
}

/** Case-insensitive filter over table and column names, for the Schema view's search box. */
export function searchTables(schema: ObservedSchema, query: string): ObservedTable[] {
  const q = query.trim().toLowerCase();
  if (!q) return schema.tables;
  return schema.tables.filter((t) => t.name.includes(q) || Object.keys(t.columns).some((c) => c.includes(q)));
}

/** Tables per page of the Schema view. */
export const SCHEMA_PAGE_SIZE = 12;

export interface SchemaPage {
  tables: ObservedTable[];
  page: number;
  pages: number;
  total: number;
}

/** One page of the (searched) tables; the page number is clamped into range. */
export function schemaPage(schema: ObservedSchema, query: string, page: number, size: number = SCHEMA_PAGE_SIZE): SchemaPage {
  const all = searchTables(schema, query);
  const pages = Math.max(1, Math.ceil(all.length / size));
  const p = Math.min(Math.max(1, Math.floor(page) || 1), pages);
  return { tables: all.slice((p - 1) * size, p * size), page: p, pages, total: all.length };
}
