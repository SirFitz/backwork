// The requests list's Pinned view (BAC-78): the `Pinned` chip that switches to it, and the list of
// pinned requests with "Load older" paging. The rows come from Postgres, not Loki.
import { Link, useFetcher, useNavigate } from "@remix-run/react";
import { useEffect, useState } from "react";
import { Pin } from "lucide-react";
import { Badge, Card, CardHead, Empty, ErrorNote } from "~/components/ui";
import { Ago } from "~/components/time";
import { fmtUs } from "~/lib/hops/time-format";
import { PIN_REASON_SHORT, type PinPage, type PinnedRequest } from "~/lib/pins";
import { cn } from "~/lib/utils";

/** The query parameter that switches the list to pinned requests. */
export const PINNED_PARAM = "pinned";

/** What the list loader returns for a later page. */
export interface PinnedOlder {
  kind: "pinned-older";
  page: PinPage;
  error: string | null;
}

/** The chip in the title row: on, it shows pinned requests; off, the live feed. */
export function PinnedChip({ on }: { on: boolean }) {
  return (
    <Link
      to={on ? "/requests" : `/requests?${PINNED_PARAM}=1`}
      aria-pressed={on}
      className={cn(
        "inline-flex h-8 items-center gap-1.5 rounded-lg border px-3 text-[12.5px] font-medium",
        on ? "border-brand/40 bg-surface-2 text-fg" : "border-border bg-surface text-muted hover:text-fg",
      )}
    >
      <Pin className="h-3.5 w-3.5" /> Pinned
    </Link>
  );
}

function statusTone(s: number | null): string {
  if (s === null) return "text-muted";
  if (s >= 500) return "text-err";
  if (s >= 400) return "text-warn";
  return "text-ok";
}

function took(p: PinnedRequest): string {
  return p.summary?.durationUs != null ? fmtUs(p.summary.durationUs) : "";
}

export function PinnedList({ first, error }: { first: PinPage; error: string | null }) {
  const navigate = useNavigate();
  const older = useFetcher<PinnedOlder>();
  const [rows, setRows] = useState<PinnedRequest[]>(first.rows);
  const [next, setNext] = useState<string | null>(first.next);
  const [olderError, setOlderError] = useState<string | null>(null);
  useEffect(() => {
    setRows(first.rows);
    setNext(first.next);
  }, [first]);
  useEffect(() => {
    const data = older.data;
    if (older.state !== "idle" || !data || data.kind !== "pinned-older") return;
    setRows((prev) => [...prev, ...data.page.rows.filter((r) => !prev.some((p) => p.traceId === r.traceId))]);
    setNext(data.page.next);
    setOlderError(data.error);
  }, [older.state, older.data]);

  return (
    <Card>
      <CardHead title="Pinned requests" sub="kept after their records expire" right={<Badge tone="neutral">{rows.length}</Badge>} />
      <ErrorNote error={error ?? olderError} />
      {rows.length === 0 ? (
        <Empty icon={<Pin className="h-5 w-5" />} title="Nothing pinned yet">Open a request and press Pin to keep it, or switch on automatic pins in Settings.</Empty>
      ) : (
        <>
          {/* phone: one card per pin; nothing scrolls sideways */}
          <ul className="divide-y divide-border md:hidden">
            {rows.map((p) => (
              <li key={`m-${p.traceId}`}>
                <Link to={`/requests/${p.traceId}`} className="block px-3.5 py-2.5 hover:bg-surface-2/50">
                  <div className="flex min-w-0 items-start justify-between gap-2.5 font-mono text-[12.5px]">
                    <span className="line-clamp-2 min-w-0 [overflow-wrap:anywhere]">{p.title}</span>
                    <span className={cn("shrink-0 font-semibold tabular-nums", statusTone(p.summary?.status ?? null))}>{p.summary?.status ?? ""}</span>
                  </div>
                  <div className="mt-[3px] flex min-w-0 items-center justify-between gap-2.5 text-[11px] text-faint">
                    <span className="min-w-0 truncate">{PIN_REASON_SHORT[p.reason]}{p.pinnedByName ? ` · ${p.pinnedByName}` : ""}{p.note ? ` · ${p.note}` : ""}</span>
                    <span className="shrink-0 font-mono tabular-nums">{took(p)} · <Ago ts={p.pinnedAt} /></span>
                  </div>
                </Link>
              </li>
            ))}
          </ul>
          <div className="hidden overflow-auto scroll-thin md:block">
            <table className="w-full text-[13px]">
              <thead className="bg-surface">
                <tr className="border-b border-border text-left text-2xs uppercase tracking-wide text-faint">
                  <th className="px-4 py-2 font-medium">Title</th>
                  <th className="px-4 py-2 text-right font-medium">Status</th>
                  <th className="px-4 py-2 text-right font-medium">Took</th>
                  <th className="px-4 py-2 font-medium">Reason</th>
                  <th className="px-4 py-2 font-medium">Pinned by</th>
                  <th className="px-4 py-2 font-medium">When</th>
                  <th className="px-4 py-2 font-medium">Note</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((p) => (
                  <tr key={p.traceId} onClick={() => navigate(`/requests/${p.traceId}`)} className="cursor-pointer border-b border-border/40 last:border-0 hover:bg-surface-2/50">
                    <td className="max-w-[360px] px-4 py-1.5 font-mono">
                      <Link to={`/requests/${p.traceId}`} onClick={(e) => e.stopPropagation()} className="block truncate hover:underline" title={p.title}>{p.title}</Link>
                    </td>
                    <td className={cn("px-4 py-1.5 text-right font-mono font-semibold tabular-nums", statusTone(p.summary?.status ?? null))}>{p.summary?.status ?? ""}</td>
                    <td className="px-4 py-1.5 text-right font-mono tabular-nums text-muted">{took(p)}</td>
                    <td className="px-4 py-1.5 text-muted">{PIN_REASON_SHORT[p.reason]}{p.trimmed ? <span className="text-faint"> · trimmed</span> : null}</td>
                    <td className="px-4 py-1.5 text-muted">{p.pinnedByName ?? (p.pinnedBy ? "" : "backwork")}</td>
                    <td className="whitespace-nowrap px-4 py-1.5 text-faint"><Ago ts={p.pinnedAt} /></td>
                    <td className="max-w-[260px] truncate px-4 py-1.5 text-muted" title={p.note ?? undefined}>{p.note ?? ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      {next !== null ? (
        <div className="flex justify-center border-t border-border p-3">
          <button
            type="button"
            disabled={older.state !== "idle"}
            onClick={() => older.load(`/requests?${PINNED_PARAM}=1&before=${encodeURIComponent(next)}`)}
            className="inline-flex h-8 items-center rounded-lg border border-border bg-surface px-3 text-[12.5px] font-medium hover:border-border-strong disabled:opacity-60"
          >
            {older.state !== "idle" ? "Loading…" : "Load older pins"}
          </button>
        </div>
      ) : null}
    </Card>
  );
}
