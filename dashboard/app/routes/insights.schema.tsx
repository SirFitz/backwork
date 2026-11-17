// Insights > Schema (BAC-93): the tables, columns and relations the queries of a project imply,
// read-only. Built from statement shapes (no connection to the database), so a column no query
// mentions is not here. The page renders at once; the schema loads in its own deferred section with
// a skeleton and its own error state, and is paginated and searchable.
import type { LoaderFunctionArgs, MetaFunction } from "@remix-run/node";
import { defer } from "@remix-run/node";
import { Form, useLoaderData } from "@remix-run/react";
import { Database } from "lucide-react";
import { Link } from "~/components/env-link";
import { Deferred, RowsSkeleton } from "~/components/defer";
import { NUM, Th } from "~/components/services-table";
import { Card, CardHead, Empty } from "~/components/ui";
import { safe } from "~/lib/config.server";
import { requireScope } from "~/lib/env.server";
import { columnsByUse, relationsOf, schemaPage, type ObservedSchema, type ObservedTable, type SchemaPage } from "~/lib/hops/observed-schema";
import { SLOW_WINDOW_MS } from "~/lib/hops/slow-queries";
import { SCHEMA_WINDOW, observedSchema, orgSuggestionsOn, type SchemaResult } from "~/lib/hops/suggest.server";
import { cn } from "~/lib/utils";

export const meta: MetaFunction = () => [{ title: "Schema · Insights · backwork" }];

const Param = { Query: "q", Page: "page" } as const;
/** Columns listed per table before "more". */
const COLUMNS_SHOWN = 10;

type ObservedColumn = ReturnType<typeof columnsByUse>[number];
/** The four ways a column is used, in the order the table and the phone list show them. */
const USE_COLUMNS: ReadonlyArray<{ label: string; count: (c: ObservedColumn) => number }> = [
  { label: "Filtered", count: (c) => c.use.where },
  { label: "Joined", count: (c) => c.use.join },
  { label: "Ordered", count: (c) => c.use.orderBy },
  { label: "Grouped", count: (c) => c.use.groupBy },
];

interface SchemaView {
  off: boolean;
  statementsOff: boolean;
  groupLimited: boolean;
  computedAt: number;
  /** Tables, relations and statements read in all, before searching. */
  totals: { tables: number; relations: number; shapes: number; skipped: number };
  page: SchemaPage;
  /** Relations of the shown tables, by table name. */
  relations: Record<string, ObservedSchema["relations"]>;
}

export async function loader({ request }: LoaderFunctionArgs) {
  const { ctx, tenant } = await requireScope(request);
  const url = new URL(request.url);
  const q = (url.searchParams.get(Param.Query) ?? "").slice(0, 80);
  const page = Number(url.searchParams.get(Param.Page) ?? "1");
  const view: Promise<{ data: SchemaView | null; error: string | null }> = safe(async () => {
    if (!(await orgSuggestionsOn(ctx.org.id))) return offView();
    const r: SchemaResult = await observedSchema(tenant);
    const shown = schemaPage(r.schema, q, page);
    return {
      off: false,
      statementsOff: r.statementsOff,
      groupLimited: r.groupLimited,
      computedAt: r.computedAt,
      totals: { tables: r.schema.tables.length, relations: r.schema.relations.length, shapes: r.schema.shapesRead, skipped: r.schema.shapesSkipped },
      page: shown,
      relations: Object.fromEntries(shown.tables.map((t) => [t.name, relationsOf(r.schema, t.name)])),
    };
  }, null);
  return defer({ q, view, hours: SLOW_WINDOW_MS[SCHEMA_WINDOW] / 3_600_000 });
}

function offView(): SchemaView {
  return { off: true, statementsOff: false, groupLimited: false, computedAt: 0, totals: { tables: 0, relations: 0, shapes: 0, skipped: 0 }, page: { tables: [], page: 1, pages: 1, total: 0 }, relations: {} };
}

function hrefFor(q: string, page: number): string {
  const p = new URLSearchParams();
  if (q) p.set(Param.Query, q);
  if (page > 1) p.set(Param.Page, String(page));
  const s = p.toString();
  return s ? `/insights/schema?${s}` : "/insights/schema";
}

export default function SchemaPageRoute() {
  const d = useLoaderData<typeof loader>();
  return (
    <Card>
      <CardHead
        title="Schema"
        sub={<span className="hidden sm:inline">what the last {d.hours} hours of queries imply, no database connection</span>}
        right={
          <Form method="get" role="search" replace preventScrollReset className="flex items-center gap-1.5">
            <input
              type="search"
              name={Param.Query}
              defaultValue={d.q}
              aria-label="Search tables and columns"
              placeholder="Search tables, columns"
              className="h-7 w-36 rounded-lg border border-border bg-surface px-2 text-xs text-fg outline-none placeholder:text-faint focus:border-brand/40 sm:w-52"
            />
          </Form>
        }
      />
      <Deferred resolve={d.view} fallback={<SchemaSkeleton />}>
        {(panel) => (panel.error || !panel.data ? <SchemaFailed error={panel.error} /> : <SchemaBody view={panel.data} q={d.q} />)}
      </Deferred>
    </Card>
  );
}

function SchemaSkeleton() {
  return <RowsSkeleton rows={6} />;
}

function SchemaFailed({ error }: { error: string | null }) {
  return (
    <div className="px-4 py-10 text-center text-[13px]">
      <p className="text-warn">The schema could not be built from the log store{error ? `: ${error.slice(0, 160)}` : "."}</p>
      <Link to="/insights/schema" reloadDocument className="mt-2 inline-block text-xs font-medium text-brand hover:underline">Retry</Link>
    </div>
  );
}

function SchemaBody({ view, q }: { view: SchemaView; q: string }) {
  if (view.off) {
    return (
      <Empty icon={<Database className="h-5 w-5" />} title="Query suggestions are switched off for this organisation, so the schema is not shown.">
        Turn them on in <Link to="/settings" className="text-brand hover:underline">Settings</Link>.
      </Empty>
    );
  }
  if (view.totals.tables === 0) {
    return view.statementsOff ? (
      <Empty icon={<Database className="h-5 w-5" />} title="Query text is switched off for this organisation, so there are no queries to read a schema from.">
        Turn it on in <Link to="/settings" className="text-brand hover:underline">Settings</Link>.
      </Empty>
    ) : (
      <Empty icon={<Database className="h-5 w-5" />} title="No database queries recorded yet, so there is nothing to build a schema from." />
    );
  }
  const { page } = view;
  return (
    <div>
      <p className="border-b border-border px-4 py-1.5 text-2xs text-muted">
        {view.totals.tables.toLocaleString("en-GB")} tables and {view.totals.relations.toLocaleString("en-GB")} relations from {view.totals.shapes.toLocaleString("en-GB")} query shapes.
        {view.groupLimited ? " Built from the 200 queries that took the most time." : ""} Only what queries used appears: types, keys and indexes are not known.
      </p>
      {page.tables.length === 0 ? (
        <p className="px-4 py-10 text-center text-[13px] text-muted">No table or column matches “{q}”.</p>
      ) : (
        <ul className="divide-y divide-border">
          {page.tables.map((t) => <TableBlock key={t.name} t={t} relations={view.relations[t.name] ?? []} />)}
        </ul>
      )}
      {page.pages > 1 ? <Pager q={q} page={page.page} pages={page.pages} total={page.total} /> : null}
    </div>
  );
}

function TableBlock({ t, relations }: { t: ObservedTable; relations: ObservedSchema["relations"] }) {
  const cols = columnsByUse(t);
  const shown = cols.slice(0, COLUMNS_SHOWN);
  return (
    <li className="px-4 py-3" data-schema-table={t.name}>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
        <h3 className="font-mono text-[13px] font-semibold">{t.name}</h3>
        <span className="text-xs text-muted">{t.reads.toLocaleString("en-GB")} reads, {t.writes.toLocaleString("en-GB")} writes, {t.shapes} {t.shapes === 1 ? "query shape" : "query shapes"}</span>
      </div>
      {shown.length > 0 ? (
        <div className="mt-2">
          {/* Phones: the column name with its four counts under it, so nothing is cut or scrolls sideways. */}
          <ul className="sm:hidden" data-schema-stack>
            {shown.map((c) => (
              <li key={c.name} className="border-b border-border py-1.5">
                <div className="break-all font-mono text-[12.5px]">{c.name}</div>
                <dl className="mt-0.5 grid grid-cols-4 gap-x-2 text-xs">
                  {USE_COLUMNS.map((u) => (
                    <div key={u.label}>
                      <dt className="text-2xs uppercase tracking-wide text-faint">{u.label}</dt>
                      <dd className={cn("mt-0.5 font-mono tabular-nums", u.count(c) === 0 && "text-faint")}>{u.count(c) === 0 ? "–" : u.count(c).toLocaleString("en-GB")}</dd>
                    </div>
                  ))}
                </dl>
              </li>
            ))}
          </ul>
          <div className="scroll-thin hidden overflow-x-auto sm:block" data-schema-scroll>
            <table className="w-full text-[13px]">
              <thead>
                <tr className="text-left">
                  <Th className="pl-0">Column</Th>
                  {USE_COLUMNS.map((u, i) => <Th key={u.label} num className={i === USE_COLUMNS.length - 1 ? "pr-0" : undefined}>{u.label}</Th>)}
                </tr>
              </thead>
              <tbody>
                {shown.map((c) => (
                  <tr key={c.name} className="h-8">
                    <td className="whitespace-nowrap border-b border-border py-0 pr-3 font-mono text-[12.5px]">{c.name}</td>
                    {USE_COLUMNS.map((u, i) => <Count key={u.label} n={u.count(c)} last={i === USE_COLUMNS.length - 1} />)}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {cols.length > shown.length ? <p className="pt-1 text-2xs text-faint">and {cols.length - shown.length} more columns.</p> : null}
        </div>
      ) : (
        <p className="mt-1 text-xs text-faint">No column of this table appears in a filter, join, order or group.</p>
      )}
      {relations.length > 0 ? (
        <div className="mt-2">
          <h4 className="text-2xs uppercase tracking-wide text-faint">Joins</h4>
          <ul className="mt-0.5 space-y-0.5 text-xs">
            {relations.slice(0, 6).map((r) => (
              <li key={`${r.from.table}.${r.from.column}=${r.to.table}.${r.to.column}`} className="flex flex-wrap items-baseline gap-x-2">
                <span className="font-mono text-fg">{r.from.table}.{r.from.column} = {r.to.table}.{r.to.column}</span>
                <span className="text-muted">{r.calls.toLocaleString("en-GB")} calls</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </li>
  );
}

function Count({ n, last = false }: { n: number; last?: boolean }) {
  return <td className={cn("whitespace-nowrap border-b border-border px-3 py-0", NUM, last && "pr-0", n === 0 && "text-faint")}>{n === 0 ? "–" : n.toLocaleString("en-GB")}</td>;
}

function Pager({ q, page, pages, total }: { q: string; page: number; pages: number; total: number }) {
  const link = "rounded-md border border-border px-2 py-1 text-xs font-medium hover:bg-surface-2";
  return (
    <nav aria-label="Pages" className="flex items-center justify-between gap-3 border-t border-border px-4 py-2 text-xs text-muted">
      <span>Page {page} of {pages} · {total.toLocaleString("en-GB")} tables</span>
      <span className="flex gap-1.5">
        {page > 1 ? <Link to={hrefFor(q, page - 1)} replace preventScrollReset className={link}>Previous</Link> : null}
        {page < pages ? <Link to={hrefFor(q, page + 1)} replace preventScrollReset className={link}>Next</Link> : null}
      </span>
    </nav>
  );
}
