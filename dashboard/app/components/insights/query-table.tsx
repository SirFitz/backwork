// The slow queries table (BAC-69): one row per statement shape, expanding in place to show the full
// statement, the routes that call it and a slow example. Pure presentation: rows and the expanded
// row's routes come from `routes/insights.queries.tsx`.
import type { ReactNode } from "react";
import { Link } from "@remix-run/react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { NUM, Th, fmtLatency, fmtShare } from "~/components/services-table";
import { Skeleton } from "~/components/ui";
import { MAX_STMT_BYTES } from "~/lib/hops/stmt";
import { shapeLabel } from "~/lib/hops/stmt-shape";
import type { QueryRow, StatementRoutes } from "~/lib/hops/slow-queries";
import { cn } from "~/lib/utils";

const CELL = "whitespace-nowrap border-b border-border px-3 first:pl-4 last:pr-4";

/** "about 12 ms" when the figure is an estimate. */
function p95Text(row: QueryRow): string {
  if (row.p95S === null) return "none";
  return row.p95Approx ? `about ${fmtLatency(row.p95S)}` : fmtLatency(row.p95S);
}

function ShareBar({ share }: { share: number }) {
  const pct = Math.max(0, Math.min(1, share));
  return (
    <span className="flex items-center justify-end gap-2">
      <span className="font-mono text-[12.5px] tabular-nums">{fmtShare(pct, 0)}</span>
      <span aria-hidden className="h-1 w-14 overflow-hidden rounded-full bg-surface-2">
        <span className="block h-full rounded-full bg-info/60" style={{ width: `${(pct * 100).toFixed(1)}%` }} />
      </span>
    </span>
  );
}

export function QueryTable({
  rows,
  openKey,
  hrefFor,
  detail,
}: {
  rows: readonly QueryRow[];
  /** `rowKey` of the expanded row, if any. */
  openKey: string | null;
  /** The link that toggles a row open or closed. */
  hrefFor: (row: QueryRow, open: boolean) => string;
  /** The expanded row's routes panel (deferred by the route). */
  detail: (row: QueryRow) => ReactNode;
}) {
  return (
    <div className="scroll-thin overflow-x-auto">
      <table className="w-full text-[13px]">
        <thead>
          <tr className="text-left">
            <Th className="pl-4">Query</Th>
            <Th className="hidden md:table-cell">Service</Th>
            <Th num>Calls</Th>
            <Th num>Total</Th>
            <Th num className="hidden sm:table-cell">p95</Th>
            <Th num className="hidden lg:table-cell pr-4">Share of database time</Th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const open = rowKey(r) === openKey;
            return (
              <QueryRowView key={rowKey(r)} row={r} open={open} href={hrefFor(r, !open)} detail={open ? detail(r) : null} />
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** A row's identity on the page: the same shape can run in two services. */
export function rowKey(row: Pick<QueryRow, "service" | "shapeId">): string {
  return `${row.service}:${row.shapeId}`;
}

function QueryRowView({ row, open, href, detail }: { row: QueryRow; open: boolean; href: string; detail: ReactNode }) {
  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <>
      <tr className={cn("h-[38px] hover:bg-surface-2/50", open && "bg-surface-2/40")}>
        <td className={cn(CELL, "max-w-0 w-full")}>
          <Link
            to={href}
            preventScrollReset
            replace
            aria-expanded={open}
            title={row.shape}
            className="flex min-w-0 items-center gap-1.5 font-mono text-[12.5px] text-fg"
          >
            <Chevron aria-hidden className="h-3.5 w-3.5 shrink-0 text-faint" />
            <span className="truncate">{shapeLabel(row.shape)}</span>
          </Link>
        </td>
        <td className={cn(CELL, "hidden text-muted md:table-cell")}>{row.service}</td>
        <td className={cn(CELL, NUM)}>{row.calls.toLocaleString("en-GB")}</td>
        <td className={cn(CELL, NUM)}>{fmtLatency(row.totalS)}</td>
        <td className={cn(CELL, NUM, "hidden sm:table-cell")}>{p95Text(row)}</td>
        <td className={cn(CELL, "hidden lg:table-cell")}><ShareBar share={row.shareOfDb} /></td>
      </tr>
      {open ? (
        <tr>
          <td colSpan={6} className="border-b border-border bg-surface-2/20 px-4 py-3">
            <QueryDetail row={row}>{detail}</QueryDetail>
          </td>
        </tr>
      ) : null}
    </>
  );
}

function QueryDetail({ row, children }: { row: QueryRow; children: ReactNode }) {
  const cut = new TextEncoder().encode(row.sample).length >= MAX_STMT_BYTES;
  return (
    <div className="min-w-0 space-y-3 whitespace-normal">
      <pre className="whitespace-pre-wrap break-all rounded-md border border-border bg-surface px-3 py-2 font-mono text-[12px] text-fg">{row.sample}</pre>
      <dl className="flex flex-wrap gap-x-6 gap-y-1 text-xs text-muted">
        <div><dt className="inline text-faint">Service </dt><dd className="inline text-fg">{row.service}</dd></div>
        {row.table ? <div><dt className="inline text-faint">Table </dt><dd className="inline font-mono text-fg">{row.table}</dd></div> : null}
        {row.peer ? <div><dt className="inline text-faint">Database </dt><dd className="inline font-mono text-fg">{row.peer}</dd></div> : null}
        <div className="sm:hidden"><dt className="inline text-faint">p95 </dt><dd className="inline font-mono text-fg">{p95Text(row)}</dd></div>
        <div className="lg:hidden"><dt className="inline text-faint">Share of database time </dt><dd className="inline font-mono text-fg">{fmtShare(row.shareOfDb, 0)}</dd></div>
      </dl>
      {row.p95Approx ? <p className="text-xs text-faint">The p95 is about: it averages the p95 of statements that differ only by their values.</p> : null}
      {cut ? <p className="text-xs text-faint">The statement was cut at {MAX_STMT_BYTES} bytes when it was recorded, so longer queries that start the same way share this row.</p> : null}
      {children}
    </div>
  );
}

function requestsHref(r: { service: string; method: string | null; op: string | null }): string {
  const p = new URLSearchParams({ service: r.service });
  if (r.method) p.set("method", r.method);
  if (r.op) p.set("route", r.op);
  return `/requests?${p.toString()}`;
}

/** The "Called by" list and the slow example link of an expanded row. */
export function CallingRoutes({ routes }: { routes: StatementRoutes }) {
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-[13px] font-semibold">Called by</h3>
        {routes.exampleTraceId ? (
          <Link to={`/requests/${routes.exampleTraceId}`} className="text-xs font-medium text-brand hover:underline">Open a slow example</Link>
        ) : null}
      </div>
      {routes.routes.length === 0 ? (
        <p className="text-xs text-muted">No route found for the {routes.sampled.toLocaleString("en-GB")} calls sampled.</p>
      ) : (
        <ul className="divide-y divide-border rounded-md border border-border bg-surface">
          {routes.routes.map((r) => (
            <li key={`${r.service}:${r.method}:${r.op}`}>
              <Link to={requestsHref(r)} className="flex items-center justify-between gap-3 px-3 py-1.5 text-xs hover:bg-surface-2/50">
                <span className="min-w-0 truncate font-mono"><span className="text-muted">{r.method ?? ""}</span> {r.op ?? "unknown route"} <span className="font-sans text-faint">{r.service}</span></span>
                <span className="shrink-0 font-mono tabular-nums text-muted">{r.calls.toLocaleString("en-GB")} {r.calls === 1 ? "call" : "calls"}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
      <p className="text-2xs text-faint">From the last {routes.sampled.toLocaleString("en-GB")} calls of this statement in the window, sampled.</p>
    </div>
  );
}

export function CallingRoutesSkeleton() {
  return (
    <div className="space-y-2">
      <Skeleton className="h-4 w-24" />
      <Skeleton className="h-7 w-full" />
      <Skeleton className="h-7 w-2/3" />
    </div>
  );
}

/** Skeleton rows at the table's row height. */
export function QueryTableSkeleton({ rows = 8 }: { rows?: number }) {
  return (
    <div className="divide-y divide-border">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="flex h-[38px] items-center gap-4 px-4">
          <Skeleton className="h-3.5 flex-1" />
          <Skeleton className="h-3.5 w-12" />
          <Skeleton className="h-3.5 w-14" />
        </div>
      ))}
    </div>
  );
}
