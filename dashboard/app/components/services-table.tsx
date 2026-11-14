// The services table (design 8.1, frame 5), shared by the Performance page and the Overview,
// with the figure formats and tones both pages use. Pure presentation: rows come from
// `metrics.server.ts` through each page's loader.
import type { ReactNode } from "react";
import { Link } from "@remix-run/react";
import { Sparkline } from "~/components/ui";
import type { ServiceRow } from "~/lib/hops/metrics.server";
import { cn } from "~/lib/utils";

/** Latency in seconds, as the frames write it: "0.6 ms", "38 ms", "2.4 s". */
export function fmtLatency(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0) return "—";
  const ms = seconds * 1000;
  if (ms < 1) return `${ms.toFixed(1)} ms`;
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${seconds.toFixed(1)} s`;
}

export function fmtRate(perSecond: number): string {
  if (perSecond > 0 && perSecond < 0.05) return "<0.1";
  return perSecond.toFixed(1);
}

export function fmtShare(share: number, digits = 1): string {
  return `${(share * 100).toFixed(digits)}%`;
}

export function errorTone(share: number): string {
  if (share >= 0.05) return "text-err";
  if (share >= 0.01) return "text-warn";
  return "";
}

/** Latency is toned only where a person waits on it: HTTP and RPC, from one second. */
export function latencyTone(seconds: number | null, waitedOn: boolean): string {
  return waitedOn && seconds !== null && seconds >= 1 ? "text-warn" : "";
}

/** Service colours from the design frames: cool hues only, so no service reads as a status
 *  (amber, red, green) or as the brand coral. A stable pick per service name. */
export const SERVICE_COLORS: readonly string[] = [
  "oklch(0.62 0.12 240)",
  "oklch(0.6 0.15 290)",
  "oklch(0.64 0.1 195)",
  "oklch(0.6 0.13 335)",
  "oklch(0.6 0.08 265)",
  "oklch(0.58 0.11 215)",
];

export function serviceColor(service: string): string {
  let h = 0;
  for (let i = 0; i < service.length; i++) h = (h * 31 + service.charCodeAt(i)) >>> 0;
  return SERVICE_COLORS[h % SERVICE_COLORS.length];
}

export const TH = "whitespace-nowrap border-b border-border px-4 py-2 text-left text-2xs font-medium uppercase tracking-wide text-faint";
export const TD = "whitespace-nowrap border-b border-border px-4 py-2";
export const NUM = "text-right font-mono text-[12.5px] tabular-nums";
/** Tighter cells for the two half-width tables (frame 5). */
export const TIGHT = "px-[7px] first:pl-4 last:pr-4";

export function Th({ children, num, className }: { children?: ReactNode; num?: boolean; className?: string }) {
  return <th className={cn(TH, num && "text-right", className)}>{children}</th>;
}

export function ServicesTable({
  rows,
  selected = null,
  hrefFor,
  onOpen,
  compact = false,
  extra,
}: {
  rows: readonly ServiceRow[];
  selected?: string | null;
  /** Where a service name links to. */
  hrefFor: (service: string) => string;
  /** Row click; omitted, only the name is a link. */
  onOpen?: (service: string) => void;
  /** Leaves out p50, the trend and in-progress columns (Overview). */
  compact?: boolean;
  /** One more column after p95 (BAC-73: "vs last week"). */
  extra?: { head: string; cell: (row: ServiceRow) => ReactNode };
}) {
  return (
    <div className="overflow-x-auto scroll-thin">
      <table className="w-full border-collapse text-[13px]">
        <thead>
          <tr>
            <Th>Service</Th>
            <Th num className={compact ? "hidden sm:table-cell" : undefined}>Req/s</Th>
            <Th num>Errors</Th>
            {compact ? null : <Th num className="hidden md:table-cell">p50</Th>}
            <Th num>p95</Th>
            {extra ? <Th num>{extra.head}</Th> : null}
            <Th num className="hidden sm:table-cell">p99</Th>
            <Th num className={compact ? "hidden sm:table-cell" : undefined}>{compact ? "Time in databases" : "DB + cache"}</Th>
            {compact ? null : <Th num className="hidden lg:table-cell">p95 trend</Th>}
            {compact ? null : <Th num className="hidden md:table-cell">In progress</Th>}
          </tr>
        </thead>
        <tbody>
          {rows.map((s) => {
            const color = serviceColor(s.service);
            const waited = s.mainVia === "http" || s.mainVia === "rpc";
            const on = s.service === selected;
            return (
              <tr
                key={s.service}
                onClick={onOpen ? () => onOpen(s.service) : undefined}
                aria-selected={on}
                className={cn(onOpen && "cursor-pointer", "[&:last-child>td]:border-b-0 hover:bg-surface-2/50", on && "bg-surface-2 hover:bg-surface-2")}
              >
                <td className={TD}>
                  <Link to={hrefFor(s.service)} preventScrollReset className="inline-flex items-center font-semibold" onClick={(e) => e.stopPropagation()}>
                    <i className="mr-2 inline-block h-2 w-2 shrink-0 rounded-full" style={{ background: color }} />
                    {s.service}
                  </Link>
                </td>
                <td className={cn(TD, NUM, compact && "hidden sm:table-cell")}>{fmtRate(s.rate)}</td>
                <td className={cn(TD, NUM, errorTone(s.errorShare))}>{fmtShare(s.errorShare)}</td>
                {compact ? null : <td className={cn(TD, NUM, "hidden md:table-cell")}>{fmtLatency(s.p50)}</td>}
                <td className={cn(TD, NUM)}>{fmtLatency(s.p95)}</td>
                {extra ? <td className={cn(TD, "text-right")}>{extra.cell(s)}</td> : null}
                <td className={cn(TD, NUM, "hidden sm:table-cell", latencyTone(s.p99, waited))}>{fmtLatency(s.p99)}</td>
                <td className={cn(TD, NUM, compact && "hidden sm:table-cell")} title={s.storeCallsPerRequest !== null ? `${s.storeCallsPerRequest.toFixed(1)} data-store calls per request` : undefined}>
                  {s.storeShare === null ? "—" : fmtShare(s.storeShare, 0)}
                </td>
                {compact ? null : (
                  <td className={cn(TD, "hidden text-right lg:table-cell")}>
                    <span className="inline-block align-middle"><Sparkline data={s.trend} color={color} width={96} height={22} /></span>
                  </td>
                )}
                {compact ? null : <td className={cn(TD, NUM, "hidden text-faint md:table-cell")}>{s.inProgress}</td>}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
