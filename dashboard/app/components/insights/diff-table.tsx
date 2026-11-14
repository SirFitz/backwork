// The comparison of two requests (BAC-75, insights plan 08): the "What differs" list, the side by
// side table, and the Compare button on the request view. Rows come from `diffRequests` (pure).
// A slower row is amber at most, a faster one neutral: a difference is a finding, not a fault.
import { Link } from "@remix-run/react";
import { useEffect, useMemo, useState } from "react";
import { GitCompare } from "lucide-react";
import { Card, CardHead } from "~/components/ui";
import { DiffKind, TYPICAL_PARAM, callsNote, differingRows, fmtDeltaUs, type DiffCell, type DiffRow } from "~/lib/hops/diff";
import { fmtUs } from "~/lib/hops/time-format";
import { HopDir, HopState, Via, type Hop } from "~/lib/hops/types";
import { cn } from "~/lib/utils";

/** Ask the table to show and scroll to a row; `seq` makes a second click on one row count. */
export interface DiffFocus {
  id: string;
  seq: number;
}

/** Element id of a row of the side by side table. */
export function diffRowAnchor(id: string): string {
  return `diff-${id}`;
}

function cellText(c: DiffCell | null): string {
  return c ? fmtUs(c.durationUs) : "none";
}

/** A signed bar around a centre line: right and amber when A took longer, left and neutral when shorter. */
export function DiffBar({ deltaUs, scaleUs, className }: { deltaUs: number; scaleUs: number; className?: string }) {
  const share = scaleUs > 0 ? Math.min(1, Math.abs(deltaUs) / scaleUs) : 0;
  const width = deltaUs === 0 ? 0 : Math.max(share * 50, 0.8);
  return (
    <div className={cn("relative h-2 rounded bg-fg/5", className)} aria-hidden>
      <span className="absolute inset-y-[-2px] left-1/2 w-px bg-border-strong" />
      {width > 0 ? (
        <span
          className={cn("absolute top-0 h-2 rounded", deltaUs > 0 ? "bg-warn/75" : "bg-faint/60")}
          style={deltaUs > 0 ? { left: "50%", width: `${width}%` } : { right: "50%", width: `${width}%` }}
        />
      ) : null}
    </div>
  );
}

function deltaTone(r: Pick<DiffRow, "kind" | "deltaUs">): string {
  return r.kind !== DiffKind.Same && r.deltaUs > 0 ? "text-warn" : "text-muted";
}

function scaleOf(rows: readonly DiffRow[], pick: (r: DiffRow) => number): number {
  return rows.reduce((m, r) => Math.max(m, Math.abs(pick(r))), 0);
}

/** "What differs": the largest contributors; a click shows the row in the table. */
export function TopDiffs({ rows, onShow }: { rows: readonly DiffRow[]; onShow: (id: string) => void }) {
  const scale = scaleOf(rows, (r) => r.contributionUs);
  return (
    <Card className="mb-4">
      <CardHead title="What differs" sub={rows.length ? "largest first" : undefined} />
      {rows.length === 0 ? (
        <p className="m-0 px-4 py-4 text-[13px] text-muted">No call took 10 ms more or less, and both made the same calls.</p>
      ) : (
        <ul className="m-0 list-none divide-y divide-border p-0">
          {rows.map((r) => {
            const own = r.hasChildren && r.kind !== DiffKind.OnlyA && r.kind !== DiffKind.OnlyB;
            const calls = callsNote(r);
            return (
              <li key={r.key}>
                <button
                  type="button"
                  onClick={() => onShow(r.id)}
                  className="grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 px-4 py-2 text-left hover:bg-surface-2 md:grid-cols-[minmax(0,1fr)_150px_minmax(120px,200px)_84px]"
                >
                  <span className="min-w-0 truncate font-mono text-[12.5px] text-fg" title={r.label}>
                    {r.label}
                    {own ? <span className="ml-1.5 font-sans text-2xs text-faint">own time</span> : null}
                    {calls ? <span className="ml-1.5 text-2xs text-faint">{calls}</span> : null}
                  </span>
                  <span className="hidden font-mono text-xs tabular-nums text-muted md:block">{cellText(r.a)} against {cellText(r.b)}</span>
                  <DiffBar className="col-span-2 md:col-span-1" deltaUs={r.contributionUs} scaleUs={scale} />
                  <span className={cn("row-start-1 text-right font-mono text-xs tabular-nums md:row-start-auto", deltaTone({ kind: r.kind, deltaUs: r.contributionUs }))}>
                    {fmtDeltaUs(r.contributionUs)}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}

const GRID = "md:grid md:grid-cols-[minmax(0,1fr)_88px_88px_minmax(150px,240px)] md:items-center md:gap-x-3";

function Cell({ c }: { c: DiffCell | null }) {
  return <span className={cn("font-mono text-xs tabular-nums", c ? "text-fg" : "text-faint")}>{cellText(c)}</span>;
}

/** "Side by side": every aligned row, folded by default to the rows that differ and those above them. */
export function DiffTable({ rows, focus, aName, bName }: { rows: readonly DiffRow[]; focus: DiffFocus | null; aName: string; bName: string }) {
  const [showAll, setShowAll] = useState(false);
  const differing = useMemo(() => differingRows(rows), [rows]);
  const shown = showAll ? rows : differing;
  const scale = scaleOf(rows, (r) => r.deltaUs);

  useEffect(() => {
    if (!focus) return;
    if (!differing.some((r) => r.id === focus.id)) setShowAll(true);
    // After the rows are drawn.
    const t = setTimeout(() => document.getElementById(diffRowAnchor(focus.id))?.scrollIntoView({ block: "center", behavior: "smooth" }), 0);
    return () => clearTimeout(t);
  }, [focus, differing]);

  const count = differing.filter((r) => r.kind !== DiffKind.Same).length;
  return (
    <Card>
      <CardHead
        title="Side by side"
        sub={count ? `${count} of ${rows.length} rows differ` : `all ${rows.length} rows alike`}
        right={
          <button
            type="button"
            aria-pressed={showAll}
            onClick={() => setShowAll((v) => !v)}
            className="h-7 rounded-md border border-border px-2.5 text-xs text-muted hover:text-fg"
          >
            {showAll ? "Only differences" : "Show all"}
          </button>
        }
      />
      <div className="overflow-x-auto">
        <div className={cn("hidden border-b border-border px-4 py-1.5 text-2xs uppercase tracking-wide text-faint md:grid", GRID)}>
          <span>Hop</span>
          <span>{aName}</span>
          <span>{bName}</span>
          <span>Difference</span>
        </div>
        {shown.length === 0 ? (
          <p className="m-0 px-4 py-4 text-[13px] text-muted">The two requests made the same calls, each within 10 ms. Show all to see every row.</p>
        ) : (
          <ul className="m-0 list-none p-0">
            {shown.map((r) => {
              const calls = callsNote(r);
              const focused = focus?.id === r.id;
              return (
                <li
                  key={r.key}
                  id={diffRowAnchor(r.id)}
                  className={cn("scroll-mt-20 border-b border-border px-4 py-1.5 last:border-b-0 md:h-[38px] md:py-0", GRID, focused && "bg-surface-2")}
                >
                  <span className="flex min-w-0 items-center gap-1.5" style={{ paddingLeft: `${Math.min(r.depth, 8) * 14}px` }}>
                    <span className={cn("min-w-0 truncate font-mono text-[12.5px]", r.kind === DiffKind.Same ? "text-muted" : "text-fg")} title={r.label}>{r.label}</span>
                    {calls ? <span className="shrink-0 rounded-full bg-surface-2 px-1.5 text-2xs text-muted">{calls}</span> : null}
                    {r.kind === DiffKind.OnlyA ? <span className="shrink-0 text-2xs text-faint">only in {aName.toLowerCase()}</span> : null}
                    {r.kind === DiffKind.OnlyB ? <span className="shrink-0 text-2xs text-faint">only in {bName.toLowerCase()}</span> : null}
                  </span>
                  {/* Phone: A over B on one line, then the bar. */}
                  <span className="mt-0.5 flex gap-3 text-2xs text-faint md:hidden" style={{ paddingLeft: `${Math.min(r.depth, 8) * 14}px` }}>
                    <span>A <Cell c={r.a} /></span>
                    <span>B <Cell c={r.b} /></span>
                    <span className={cn("ml-auto font-mono tabular-nums", deltaTone(r))}>{fmtDeltaUs(r.deltaUs)}</span>
                  </span>
                  <span className="hidden md:block"><Cell c={r.a} /></span>
                  <span className="hidden md:block"><Cell c={r.b} /></span>
                  <span className="mt-1 flex items-center gap-2 md:mt-0">
                    <DiffBar className="min-w-0 flex-1" deltaUs={r.deltaUs} scaleUs={scale} />
                    <span className={cn("hidden w-[70px] shrink-0 text-right font-mono text-xs tabular-nums md:inline", deltaTone(r))}>{fmtDeltaUs(r.deltaUs)}</span>
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </Card>
  );
}

/** The request view's Compare button: inbound HTTP requests that finished. */
export function CompareButton({ traceId, head }: { traceId: string; head: Pick<Hop, "dir" | "via" | "state"> }) {
  if (head.dir !== HopDir.In || head.via !== Via.Http || head.state !== HopState.Finished) return null;
  return (
    <Link
      to={`/requests/${traceId}/vs/${TYPICAL_PARAM}`}
      title="Compare with a typical request of this route"
      className="inline-flex items-center gap-1 whitespace-nowrap text-muted hover:text-fg hover:underline"
    >
      <GitCompare className="h-3.5 w-3.5" aria-hidden /> Compare
    </Link>
  );
}
