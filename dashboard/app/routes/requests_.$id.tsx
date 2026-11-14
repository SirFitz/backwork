// The request view (design 7, 8): one request, every hop, what each service logged.
// The page returns at once; hop records (searched window by window) and log lines
// each stream in on their own, with their own skeleton and error state.
import type { ActionFunctionArgs, LoaderFunctionArgs, MetaFunction } from "@remix-run/node";
import { defer } from "@remix-run/node";
import { Await, Link, isRouteErrorResponse, useLoaderData, useRouteError } from "@remix-run/react";
import { Fragment, Suspense, useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import {
  ArrowLeft, ArrowRight, Check, ChevronDown, ChevronRight, Copy, CornerDownRight, Database, Link2, LogIn, OctagonX, RotateCcw, SearchX, Unplug, Zap,
} from "lucide-react";
import { Badge, Card, CardHeadText, Skeleton } from "~/components/ui";
import { Deferred, RowsSkeleton } from "~/components/defer";
import { hasRole, requireOrg } from "~/lib/auth/context.server";
import { tenantOf } from "~/lib/tenant.server";
import { logLinesFor, logsOnly, progressiveLookup } from "~/lib/hops/query.server";
import { pinAction, withPinFallback, type PinnedLookupResult } from "~/lib/pins.server";
import { PIN_REASON_LABEL, type PinnedCopyInfo, type PinnedRequest } from "~/lib/pins";
import { PinButton } from "~/components/insights/pin-button";
import { PinnedBanner } from "~/components/insights/pinned-banner";
import { splitRequests, type RequestPart } from "~/lib/hops/split";
import { buildRequestTree, faultCount, headHop, isFailed, storeCallCounts } from "~/lib/hops/tree";
import { buildPathNodes, expandableKeys, pathKeysTo, rowUs, visibleRows, type PathNode, type VisibleRow } from "~/lib/hops/path-rows";
import { detectRepeats, repeatChip, repeatHint, repeatNote, repeatSentence, repeatsByHop, type RepeatGroup, type RepeatReport } from "~/lib/hops/repeated";
import { RepeatChip } from "~/components/insights/repeat-chip";
import { candidatesByHop, parallelCandidates, parallelSentence, PARALLEL_CHIP, type ParallelCandidate } from "~/lib/hops/concurrency";
import { CHATTY_BADGE, chattyRequest, chattySentence } from "~/lib/hops/chatty";
import { ParallelChip } from "~/components/insights/parallel-chip";
import { WhyLine } from "~/components/insights/why-line";
import { whyItWasSlow } from "~/lib/hops/verdict";
import { calledPeers, peerPairs } from "~/lib/hops/peers";
import { sharedDatabaseHost, storeLabel, statementTail } from "~/lib/hops/store-label";
import { knownPeersFor } from "~/lib/hops/peers.server";
import { pathTitle, requestPath, routeHint } from "~/lib/hops/paths";
import { failedCallsSentence, requestProblems, retriedSentence } from "~/lib/hops/problems";
import { fmtUs, plural } from "~/lib/hops/time-format";
import { storeCallFacts, storeTotalsChips, waitSuffix, waitSuffixOf } from "~/lib/hops/cache-pool";
import { GapKind, HOP_RETENTION_DAYS, HopDir, HopKind, HopState, LOG_PAGE, LOG_RETENTION_DAYS, Outcome, SearchWindow, StoreKind, Via, WINDOW_LABEL, type Hop, type HopId, type HopRecord, type LinkedId, type RequestTree, type TraceId, type TraceLogLine } from "~/lib/hops/types";
import { cn } from "~/lib/utils";
import { Clock, useHydrated } from "~/components/time";

export const meta: MetaFunction<typeof loader> = ({ data }) => [{ title: `Request ${data?.traceId.slice(0, 8) ?? ""} · backwork.dev` }];

/** A trace ID in the path: up to 32 hex (older links may have trimmed leading zeros), padded to 32. */
function traceIdFromPath(raw: string | undefined): TraceId | null {
  if (!raw || raw.length > 32) return null;
  const lower = raw.toLowerCase();
  for (let i = 0; i < lower.length; i++) {
    const c = lower.charCodeAt(i);
    if (!((c >= 48 && c <= 57) || (c >= 97 && c <= 102))) return null;
  }
  const id = lower.padStart(32, "0");
  return /^0+$/.test(id) ? null : (id as TraceId);
}

interface Found {
  records: HopRecord[];
  links: LinkedId[];
  window: SearchWindow;
  /** Peers some service of the organisation has answered as (design 9); null when unknown. */
  knownPeers: string[] | null;
  /** The window hit the fetch limit: counts are floors (BAC-68 "at least"). */
  truncated: boolean;
  /** This request's pin, if any (BAC-78). */
  pin: PinnedRequest | null;
  /** Set when the records are the pinned copy, not Loki's. */
  copy: PinnedCopyInfo | null;
}

/** A found window, with the peers it calls looked up (and the pairs it links saved). */
function toFound(orgId: string): (l: PinnedLookupResult) => Promise<Found | null> {
  return async ({ result: r, pin, copy }) => {
    if (!r.found) return null;
    const knownPeers = await knownPeersFor(orgId, peerPairs(r.records), calledPeers(r.records));
    return { records: r.records, links: r.links, window: r.window, knownPeers, truncated: r.truncated, pin, copy };
  };
}

type Settled<T> = { ok: true; value: T } | { ok: false; error: string };

function settle<T>(p: Promise<T>): Promise<Settled<T>> {
  return p.then(
    (value): Settled<T> => ({ ok: true, value }),
    (e: unknown): Settled<T> => ({ ok: false, error: e instanceof Error ? e.message.slice(0, 160) : "unavailable" }),
  );
}

export async function loader({ request, params }: LoaderFunctionArgs) {
  const ctx = await requireOrg(request);
  const tenant = tenantOf(ctx.org.id);
  // Each part settles to a value, so a backend that is down shows that part's error state
  // and nothing is thrown into the browser.
  const traceId = traceIdFromPath(params.id);
  const q = new URL(request.url).searchParams.get("q");
  const now = Date.now();
  if (!traceId) throw new Response("Not a trace ID", { status: 404 });

  // Loki first; a pinned copy when Loki no longer has the request (BAC-78).
  const lookup = withPinFallback(progressiveLookup(traceId, tenant, now), ctx.org.id, traceId, now);
  const found = toFound(ctx.org.id);
  const logs = lookup.retention.then((l) => (l.lines ?? (l.result.found ? logLinesFor(traceId, l.result, tenant, now) : [])));
  // Hop records off: the lines alone, grouped by service (design 7.2).
  const onlyLogs = lookup.retention.then((l) => (l.result.found ? null : logsOnly(traceId, tenant, now)));
  return defer({
    traceId,
    // The original input when it was not the trace ID itself (a request ID, a UUID, a traceparent).
    input: q && q.toLowerCase() !== traceId ? q.slice(0, 200) : null,
    now,
    canPin: hasRole(ctx.role, "member"),
    hour: settle(lookup.hour.then(found)),
    day: settle(lookup.day.then(found)),
    retention: settle(lookup.retention.then(found)),
    logs: settle(logs),
    onlyLogs: settle(onlyLogs),
  });
}

/** Pin and unpin (BAC-78): same origin, member and above, records fetched again server side. */
export async function action({ request, params }: ActionFunctionArgs) {
  return pinAction(request, traceIdFromPath(params.id));
}

// ---------------------------------------------------------------- formatting

/** Re-exported for existing importers; the formatter lives in lib/hops/time-format.ts. */
export { fmtUs };

function elapsedUs(hop: Hop, now: number): number {
  return hop.durationUs ?? Math.max(0, Math.round((now - hop.startMs) * 1000));
}

function tookText(hop: Hop, now: number): string {
  return hop.state === HopState.Finished ? (hop.durationUs !== null ? fmtUs(hop.durationUs) : "") : `${fmtUs(elapsedUs(hop, now))} +`;
}

function dayWord(ts: number, now: number, local: boolean): string {
  const a = new Date(ts);
  const b = new Date(now);
  const day = (d: Date): string => (local ? d.toDateString() : d.toISOString().slice(0, 10));
  if (day(a) === day(b)) return "today";
  return a.toLocaleDateString("en-GB", { day: "numeric", month: "short", ...(local ? {} : { timeZone: "UTC" }) });
}

/** "today" or "12 Nov", in the viewer's zone once hydrated (components/time.tsx). */
function DayWord({ ts, now }: { ts: number; now: number }) {
  const local = useHydrated();
  return <span suppressHydrationWarning>{dayWord(ts, now, local)}</span>;
}

// Service colours: stable per service name (DESIGN.md: "assigned by service, stable"), distinct within a request.
const HOP_PALETTE = [
  "oklch(0.62 0.12 240)", "oklch(0.6 0.15 290)", "oklch(0.64 0.1 195)", "oklch(0.6 0.13 335)",
  "oklch(0.6 0.08 265)", "oklch(0.62 0.12 160)", "oklch(0.6 0.03 60)", "oklch(0.62 0.13 120)",
];

function colourMap(services: readonly string[]): Map<string, string> {
  const used = new Set<number>();
  const out = new Map<string, string>();
  for (const s of services) {
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    let idx = h % HOP_PALETTE.length;
    for (let k = 0; k < HOP_PALETTE.length && used.has(idx); k++) idx = (idx + 1) % HOP_PALETTE.length;
    used.add(idx);
    out.set(s, HOP_PALETTE[idx]);
  }
  return out;
}

type Tone = "neutral" | "ok" | "warn" | "err";

function statusOf(hop: Hop): { text: string; tone: Tone } {
  const stopped = hop.gaps.some((g) => g.kind === GapKind.Stopped);
  if (stopped) return { text: "stopped here", tone: "err" };
  if (hop.state !== HopState.Finished) return { text: "open", tone: "neutral" };
  if (hop.isStore) return hop.outcome === Outcome.Error ? { text: "error", tone: "err" } : { text: "ok", tone: "neutral" };
  if (hop.status !== null) return { text: String(hop.status), tone: hop.status >= 500 ? "err" : hop.status >= 400 ? "warn" : "ok" };
  if (hop.outcome === Outcome.Error) return { text: "error", tone: "err" };
  return { text: "ok", tone: hop.dir === HopDir.In ? "ok" : "neutral" };
}

function storeIcon(via: Via, className: string): ReactNode {
  return via === Via.Cache ? <Zap className={className} /> : <Database className={className} />;
}

/** "queue receipts" for a job, the peer for a call, the route for an inbound hop. */
function outLabel(hop: Hop): string {
  if (hop.via === Via.Job) return `queue ${hop.peer ?? hop.op ?? ""}`.trim();
  if (hop.via === Via.Message) return `topic ${hop.peer ?? hop.op ?? ""}`.trim();
  return hop.peer ?? hop.op ?? hop.via;
}

function noteOf(hop: Hop): string {
  const parts: string[] = [];
  if (hop.error) parts.push(hop.error);
  if (hop.gaps.some((g) => g.kind === GapKind.NotLinked)) parts.push("outside");
  if (hop.gaps.some((g) => g.kind === GapKind.NotInstrumented)) parts.push("not instrumented yet");
  for (const g of hop.gaps) if (g.kind === GapKind.Retry) parts.push(g.label.toLowerCase());
  if (hop.handoff) parts.push("background");
  else if (hop.afterResponse) parts.push("after the response");
  return parts.join(" · ");
}

// ---------------------------------------------------------------- shared bits

function Mono({ children, className, title }: { children: ReactNode; className?: string; title?: string }) {
  return <span className={cn("font-mono tabular-nums", className)} title={title}>{children}</span>;
}

function Dot({ colour }: { colour: string }) {
  return <i className="inline-block h-2 w-2 shrink-0 rounded-full" style={{ background: colour }} aria-hidden />;
}

function IoTag({ dir }: { dir: HopDir }) {
  return (
    <span className="min-w-[27px] shrink-0 rounded-[3px] border border-border bg-bg px-1 text-center font-mono text-[9.5px] font-medium uppercase leading-[1.5] text-faint">
      {dir}
    </span>
  );
}

function CopyButton({ value }: { value: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="text-faint hover:text-fg"
      aria-label="Copy trace ID"
      onClick={() => {
        void navigator.clipboard?.writeText(value).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        });
      }}
    >
      {done ? <Check className="h-[13px] w-[13px]" /> : <Copy className="h-[13px] w-[13px]" />}
    </button>
  );
}

const HATCH = (c: string): CSSProperties => ({
  border: `1.5px dashed ${c}`,
  borderRight: 0,
  borderRadius: "4px 0 0 4px",
  background: `repeating-linear-gradient(135deg, color-mix(in oklch, ${c} 45%, transparent) 0 5px, transparent 5px 10px)`,
});

interface BarGeom {
  left: number;
  width: number;
  open: boolean;
  later: string | null;
}

function geometry(hop: Hop, axisStart: number, axisMs: number, now: number): BarGeom {
  const startOff = hop.startMs - axisStart;
  if (startOff > axisMs * 1.02) {
    return { left: 74, width: 26, open: hop.state !== HopState.Finished, later: `${fmtUs((hop.startMs - (axisStart + axisMs)) * 1000)} later` };
  }
  const left = Math.min(100, Math.max(0, (startOff / axisMs) * 100));
  if (hop.state !== HopState.Finished) return { left, width: Math.max(100 - left, 0.9), open: true, later: null };
  // A start moved to its caller's start (skewMs) is drawn from there to where it ended.
  const drawnMs = hop.skewMs > 0 && hop.endMs !== null ? hop.endMs - hop.startMs : elapsedUs(hop, now) / 1000;
  const width = Math.min(100 - left, Math.max((drawnMs / axisMs) * 100, 0.9));
  return { left, width: Math.max(width, 0.9), open: false, later: null };
}

function Bar({ hop, colour, geom, thin = false }: { hop: Hop; colour: string; geom: BarGeom; thin?: boolean }) {
  const failed = isFailed(hop) || hop.gaps.some((g) => g.kind === GapKind.Stopped);
  const style: CSSProperties = { left: `${geom.left}%`, width: `${geom.width}%` };
  if (geom.open) Object.assign(style, HATCH(colour));
  else if (hop.handoff || hop.afterResponse) {
    // Beside the request, not part of it: outlined only, so it reads as running alongside.
    style.background = "transparent";
    style.boxShadow = `inset 0 0 0 1.5px ${hop.isStore ? "oklch(var(--muted))" : colour}`;
    style.opacity = 0.7;
  } else if (hop.isStore) style.background = "oklch(var(--muted))";
  else if (hop.dir === HopDir.In) style.background = colour;
  else {
    style.background = `color-mix(in oklch, ${colour} 22%, transparent)`;
    style.boxShadow = `inset 0 0 0 1.5px ${colour}`;
  }
  if (failed) {
    style.outline = "1.5px solid oklch(var(--err))";
    style.outlineOffset = "1.5px";
  }
  return (
    <div className={cn("relative rounded bg-fg/5", thin ? "h-2" : "h-4")}>
      {geom.later ? (
        <span className="absolute right-[28%] top-0 border-r border-dashed border-border-strong pr-2 font-mono text-[10.5px] leading-4 text-faint">{geom.later}</span>
      ) : null}
      <span className={cn("absolute top-0 min-w-[3px] rounded", thin ? "h-2" : "h-4")} style={style} />
    </div>
  );
}

// ---------------------------------------------------------------- the page

export default function RequestPage() {
  const d = useLoaderData<typeof loader>();
  return (
    <div className="animate-fade-in">
      <Link to="/requests" className="mb-2 inline-flex items-center gap-1.5 text-[13px] text-muted hover:text-fg">
        <ArrowLeft className="h-[15px] w-[15px]" /> Requests
      </Link>
      <Progressive d={d} />
    </div>
  );
}

type Data = ReturnType<typeof useLoaderData<typeof loader>>;

function SearchingNote({ text }: { text: string }) {
  return (
    <div>
      <div className="mb-4 flex items-start justify-between gap-8">
        <div className="space-y-2.5">
          <Skeleton className="h-7 w-72 animate-pulse" />
          <Skeleton className="h-4 w-96 max-w-full animate-pulse" />
        </div>
        <Skeleton className="hidden h-16 w-80 animate-pulse md:block" />
      </div>
      <Card>
        <div className="flex items-center gap-2 border-b border-border px-4 py-3 text-[12.5px] text-muted" role="status">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-info" />
          {text}
        </div>
        <RowsSkeleton rows={6} />
      </Card>
    </div>
  );
}

function LookupFailed() {
  return (
    <Card>
      <div className="px-4 py-10 text-center text-[13px] text-err">Hop records unavailable: the log store did not answer. Reload to try again.</div>
    </Card>
  );
}

/** Hour, then day, then the rest of the retention: the page says which window is still being searched. */
function Progressive({ d }: { d: Data }) {
  const view = (found: Found) => <RequestView found={found} d={d} />;
  return (
    <Suspense fallback={<SearchingNote text={`Searching hop records for ${WINDOW_LABEL.hour}…`} />}>
      <Await resolve={d.hour} errorElement={<LookupFailed />}>
        {(hourS: Settled<Found | null>) => !hourS.ok ? <LookupFailed /> : hourS.value ? view(hourS.value) : (
            <Suspense fallback={<SearchingNote text={`Not in ${WINDOW_LABEL.hour}. Searching ${WINDOW_LABEL.day}…`} />}>
              <Await resolve={d.day} errorElement={<LookupFailed />}>
                {(dayS: Settled<Found | null>) => !dayS.ok ? <LookupFailed /> : dayS.value ? view(dayS.value) : (
                    <Suspense fallback={<SearchingNote text={`Not in ${WINDOW_LABEL.day}. Searching ${WINDOW_LABEL.retention}…`} />}>
                      <Await resolve={d.retention} errorElement={<LookupFailed />}>
                        {(allS: Settled<Found | null>) => (!allS.ok ? <LookupFailed /> : allS.value ? view(allS.value) : <LogsOnly d={d} />)}
                      </Await>
                    </Suspense>
                  )
                }
              </Await>
            </Suspense>
          )
        }
      </Await>
    </Suspense>
  );
}

const LogsState = { Loading: "loading", Ready: "ready", Failed: "failed" } as const;
type LogsState = (typeof LogsState)[keyof typeof LogsState];

function RequestView({ found, d }: { found: Found; d: Data }) {
  return (
    <Suspense fallback={<Tree found={found} d={d} logs={[]} logsState={LogsState.Loading} />}>
      <Await resolve={d.logs} errorElement={<Tree found={found} d={d} logs={[]} logsState={LogsState.Failed} />}>
        {(logs: Settled<TraceLogLine[]>) => logs.ok
          ? <Tree found={found} d={d} logs={logs.value} logsState={LogsState.Ready} />
          : <Tree found={found} d={d} logs={[]} logsState={LogsState.Failed} />}
      </Await>
    </Suspense>
  );
}

/** One trace ID can hold several requests (a page's GET, then its form's POST): one switcher tab each. */
function Tree({ found, d, logs, logsState }: { found: Found; d: Data; logs: TraceLogLine[]; logsState: LogsState }) {
  const parts = useMemo(() => splitRequests(found.records, logs, found.links), [found, logs]);
  const [sel, setSel] = useState(0);
  const part = parts[Math.min(sel, parts.length - 1)];
  return (
    <>
      {found.copy ? <PinnedBanner copy={found.copy} /> : null}
      {parts.length > 1 ? <RequestSwitcher parts={parts} sel={sel} onSelect={setSel} /> : null}
      <OneRequest key={sel} found={found} part={part} d={d} logsState={logsState} logsTotal={logs.length} />
    </>
  );
}

function partLabel(part: RequestPart): string {
  const first = part.records.find((r) => r.hop === HopKind.In || r.hop === HopKind.InEnd) ?? part.records[0];
  if (!first) return "request";
  return `${first.method ? `${first.method} ` : ""}${first.path ?? first.op ?? first.service}`;
}

function RequestSwitcher({ parts, sel, onSelect }: { parts: RequestPart[]; sel: number; onSelect: (i: number) => void }) {
  return (
    <nav aria-label="Requests in this trace" className="mb-4 rounded-lg border border-border bg-surface px-3 py-2.5">
      <p className="m-0 mb-1.5 text-2xs text-faint">
        {parts.length} separate requests share this trace ID. Showing one at a time.
      </p>
      <div className="flex flex-wrap gap-1.5">
        {parts.map((p, i) => (
          <button
            key={p.startMs + ":" + i}
            type="button"
            aria-pressed={i === sel}
            onClick={() => onSelect(i)}
            className={cn(
              "max-w-full rounded-md border px-2.5 py-1 text-left font-mono text-xs [overflow-wrap:anywhere]",
              i === sel ? "border-brand bg-surface-2 text-fg" : "border-border text-muted hover:text-fg",
            )}
          >
            <span className="font-medium">{partLabel(p)}</span>
            <span className="ml-2 text-faint">{i === 0 ? "first" : `+${fmtGap(p.startMs - parts[0].startMs)}`}</span>
          </button>
        ))}
      </div>
    </nav>
  );
}

function fmtGap(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(2)} s`;
  return `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`;
}

function OneRequest({ found, part, d, logsState, logsTotal }: { found: Found; part: RequestPart; d: Data; logsState: LogsState; logsTotal: number }) {
  const logs = part.logs;
  const tree = useMemo(
    () => buildRequestTree(part.records, part.logs, d.now, part.links, found.knownPeers ? new Set(found.knownPeers) : null),
    [part, found, d.now],
  );
  const colours = useMemo(() => colourMap(tree.services), [tree.services]);
  const defaultOpen = tree.gaps.find((g) => g.kind === GapKind.Stopped)?.hopId ?? null;
  const [openHop, setOpenHop] = useState<string | null>(defaultOpen);
  // Repeated calls (BAC-68): found once per tree; the header fact opens and scrolls to the first.
  const repeats = useMemo(() => detectRepeats(tree, found.truncated), [tree, found.truncated]);
  const repeatOf = useMemo(() => repeatsByHop(repeats), [repeats]);
  // Calls that could run together (BAC-71), by hop id.
  const parallelOf = useMemo(() => candidatesByHop(parallelCandidates(tree, repeats)), [tree, repeats]);
  const [focus, setFocus] = useState<RepeatFocus | null>(null);
  // Why it was slow (BAC-70): from hop records only, so the build with logs gives the same line.
  const verdict = useMemo(() => whyItWasSlow(tree, repeats, d.now), [tree, repeats, d.now]);
  const head = headHop(tree);
  if (!head) return <LogsOnly d={d} />;
  const lastLog = logs.length ? logs[logs.length - 1].timeMs : null;
  const ctx: RowCtx = {
    tree, colours, now: d.now, openHop, setOpenHop, logsState, traceId: d.traceId, repeatOf, parallelOf, focus,
    axisStart: head.startMs, axisMs: Math.max(elapsedUs(head, d.now) / 1000, 0.001),
  };
  return (
    <>
      <Header tree={tree} head={head} d={d} pin={found.pin} repeats={repeats} onShowRepeat={(hopId) => setFocus((f) => ({ hopId, seq: (f?.seq ?? 0) + 1 }))} />
      <Alert tree={tree} lastLog={lastLog} logsState={logsState} />
      <WhyLine verdict={verdict} onShow={(hopId) => setFocus((f) => ({ hopId, seq: (f?.seq ?? 0) + 1 }))} />
      <div className="hidden md:block"><TimeSplitBar tree={tree} head={head} colour={colours.get(head.service) ?? HOP_PALETTE[0]} /></div>
      <PathCard ctx={ctx} />
      <div className="mt-4 space-y-4 md:hidden">
        <IdList tree={tree} d={d} />
        <TimeSplitBar tree={tree} head={head} colour={colours.get(head.service) ?? HOP_PALETTE[0]} />
      </div>
      {logsState === LogsState.Ready && logsTotal >= LOG_PAGE ? (
        <p className="mt-3 text-2xs text-faint">
          The first {LOG_PAGE.toLocaleString("en-GB")} log lines are placed above.{" "}
          <Link className="text-brand" to={`/logs?q=${d.traceId}&range=24h`}>Open every line in Logs</Link>
        </p>
      ) : null}
    </>
  );
}

// ---------------------------------------------------------------- header, facts, IDs

function Title({ head, size = "lg", pinned = false }: { head: Hop; size?: "lg" | "sm"; pinned?: boolean }) {
  const status = statusOf(head);
  // The path this request called (HOP-24) is the title; its route template goes under it.
  const label = requestPath(head) ?? (head.dir === HopDir.In ? head.service : outLabel(head));
  const route = routeHint(head);
  return (
    <>
      <h1 className={cn("m-0 flex flex-wrap items-center gap-2.5 font-mono font-semibold tracking-tight", size === "lg" ? "text-[21px]" : "text-base leading-snug")}>
        {/* A path wraps (HOP-24 caps it at 200 bytes); the whole value on hover too. */}
        <span className="min-w-0 [overflow-wrap:anywhere]" title={pathTitle(head.path, head.op) ?? label ?? undefined}>
          {head.method ? <span className="font-medium text-faint">{head.method} </span> : null}
          {label}
        </span>
        <Badge tone={status.tone}>{status.text}</Badge>
        {pinned ? <Badge>Pinned</Badge> : null}
      </h1>
      {route ? <div className="mt-0.5 font-mono text-[12.5px] text-faint [overflow-wrap:anywhere]">route {route}</div> : null}
    </>
  );
}

function Header({ tree, head, d, pin, repeats, onShowRepeat }: { tree: RequestTree; head: Hop; d: Data; pin: PinnedRequest | null; repeats: RepeatReport; onShowRepeat: (hopId: HopId) => void }) {
  const counts = storeCallCounts(tree);
  const stores = counts.db + counts.cache;
  const chatty = chattyRequest(tree);
  const storeWord = counts.db && counts.cache ? ["database and cache call", "database and cache calls"] : counts.cache ? ["cache call", "cache calls"] : ["database call", "database calls"];
  const jobs = tree.hops.filter((h) => h.dir === HopDir.In && h.via === Via.Job).length;
  const hopCount = tree.hops.filter((h) => !h.isStore).length;
  const faults = faultCount(tree);
  const fact = "whitespace-nowrap";
  return (
    <div data-content className="mb-4 flex items-start justify-between gap-8">
      <div className="min-w-0">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="hidden md:block"><Title head={head} pinned={pin !== null} /></div>
            <div className="md:hidden"><Title head={head} size="sm" pinned={pin !== null} /></div>
          </div>
          {d.canPin ? <PinButton traceId={d.traceId} pinned={pin !== null} /> : null}
        </div>
        <div className="mt-2 flex flex-wrap gap-x-[18px] gap-y-1 text-[12.5px] text-muted">
          <span className={fact}>Started <Mono className="font-medium text-fg"><Clock ts={head.startMs} /></Mono><span className="hidden md:inline"> <DayWord ts={head.startMs} now={d.now} /></span></span>
          <span className={fact}>Took <Mono className="font-medium text-fg">{tookText(head, d.now)}</Mono></span>
          <span className={cn(fact, "hidden md:inline")}><b className="font-medium text-fg">{tree.services.length}</b> {tree.services.length === 1 ? "service" : "services"}</span>
          <span className={cn(fact, "hidden md:inline")}><b className="font-medium text-fg">{hopCount}</b> {hopCount === 1 ? "hop" : "hops"}</span>
          {stores ? <span className={cn(fact, "hidden md:inline")}><b className="font-medium text-fg">{stores}</b> {stores === 1 ? storeWord[0] : storeWord[1]}{chatty.chatty ? <> <span title={chattySentence(chatty)}><Badge tone="neutral">{CHATTY_BADGE}</Badge></span></> : null}</span> : null}
          {repeats.repeatedCalls ? (
            <button
              type="button"
              className={cn(fact, "text-left hover:text-fg hover:underline")}
              title={repeatSentence(repeats.groups[0])}
              onClick={() => onShowRepeat(repeats.groups[0].hopIds[0])}
            >
              <b className="font-medium text-fg">{repeats.repeatedCalls}</b> repeated {repeats.repeatedCalls === 1 ? "call" : "calls"}
            </button>
          ) : null}
          {jobs ? <span className={cn(fact, "hidden md:inline")}><b className="font-medium text-fg">{jobs}</b> {jobs === 1 ? "background job" : "background jobs"}</span> : null}
          {pin ? (
            <span className="min-w-0 max-w-full truncate" title={pin.note ?? undefined}>
              {PIN_REASON_LABEL[pin.reason].replace(/^./, (c) => c.toUpperCase())}{pin.note ? <>: <span className="text-fg">{pin.note}</span></> : null}
            </span>
          ) : null}
          <span className={cn(fact, faults ? "text-err" : "hidden md:inline")}><b className={cn("font-medium", faults ? "text-err" : "text-fg")}>{faults}</b> {faults === 1 ? "gap" : "gaps"}</span>
        </div>
      </div>
      <div className="hidden md:block"><IdList tree={tree} d={d} /></div>
    </div>
  );
}

function IdList({ tree, d }: { tree: RequestTree; d: Data }) {
  const row = "flex items-center gap-2.5 md:justify-end";
  const dt = "text-[10.5px] uppercase tracking-wide text-faint";
  const dd = "m-0 inline-flex min-w-0 items-center gap-1.5 font-mono text-[11.5px] [overflow-wrap:anywhere]";
  return (
    <dl className="m-0 mt-0.5 grid gap-[5px] text-xs">
      <div className={row}><dt className={dt}>Trace</dt><dd className={dd}>{d.traceId} <CopyButton value={d.traceId} /></dd></div>
      {d.input ? <div className={row}><dt className={dt}>Request ID</dt><dd className={dd}>{d.input}</dd></div> : null}
      {tree.linkedIds.length ? (
        <div className={row}>
          <dt className={dt}>Linked</dt>
          <dd className={cn(dd, "flex-wrap")}>
            {tree.linkedIds.map((l, i) => (
              <Fragment key={`${l.name}:${l.value}`}>
                {i ? <i className="not-italic text-faint">·</i> : null}
                <span>{l.name} {l.value}</span>
              </Fragment>
            ))}
          </dd>
        </div>
      ) : null}
    </dl>
  );
}

// ---------------------------------------------------------------- what is wrong, in a sentence

function Alert({ tree, lastLog, logsState }: { tree: RequestTree; lastLog: number | null; logsState: LogsState }) {
  const byId = new Map(tree.hops.map((h) => [h.hopId, h]));
  const stopped = tree.gaps.filter((g) => g.kind === GapKind.Stopped);
  const missing = tree.gaps.filter((g) => g.kind === GapKind.NoReceiver);
  // A request can finish with no gap and still have failed underneath (frame 3's lead, BAC-41).
  const problems = requestProblems(tree);
  if (!stopped.length && !missing.length && !problems.failedCalls.length && !problems.retried) return null;
  const row = "flex gap-[11px] py-[9px] text-[13px] leading-normal text-fg [&+&]:border-t [&+&]:border-err/20";
  return (
    <div className="mb-4 rounded-[10px] border border-err/40 bg-err/[0.09] px-3.5 py-1" role="alert">
      {stopped.map((g) => {
        const h = byId.get(g.hopId) as Hop;
        return (
          <div key={g.hopId} className={row}>
            <OctagonX className="mt-px h-[17px] w-[17px] shrink-0 text-err" />
            <div>
              <b className="font-semibold">Stopped in {h.service}.</b>{" "}
              {h.dir === HopDir.Out ? <>The call to <Mono className="text-xs">{outLabel(h)}</Mono></> : <Mono className="text-xs">{h.op ?? h.via}</Mono>}
              <span className="hidden md:inline"> started at <Mono className="text-xs"><Clock ts={h.startMs} /></Mono> and</span> never finished.
              {lastLog !== null && logsState === LogsState.Ready ? (
                <span className="hidden md:inline"> Last log line for this request: <Mono className="text-xs"><Clock ts={lastLog} /></Mono>.</span>
              ) : null}
            </div>
          </div>
        );
      })}
      {problems.failedCalls.map((f) => (
        <div key={`fc-${f.destination}`} className={row}>
          <OctagonX className="mt-px h-[17px] w-[17px] shrink-0 text-err" />
          <div><b className="font-semibold">{failedCallsSentence(f)}</b></div>
        </div>
      ))}
      {problems.retried ? (
        <div className={row}>
          <RotateCcw className="mt-px h-[17px] w-[17px] shrink-0 text-warn" />
          <div><b className="font-semibold">{retriedSentence(problems.retried)}</b></div>
        </div>
      ) : null}
      {missing.length ? (
        <div className={cn(row, "hidden md:flex")}>
          <Unplug className="mt-px h-[17px] w-[17px] shrink-0 text-warn" />
          <div>
            <b className="font-semibold">{missing.length === 1 ? "One call was never received." : `${missing.length} calls were never received.`}</b>{" "}
            {missing.map((g, i) => {
              const h = byId.get(g.hopId) as Hop;
              return (
                <Fragment key={g.hopId}>
                  {i ? " " : ""}
                  {h.via === Via.Job ? <>A job sent to queue <Mono className="text-xs">{h.peer}</Mono> has no record on the other side.</> : <>A call to <Mono className="text-xs">{outLabel(h)}</Mono> has no record on the other side.</>}
                </Fragment>
              );
            })}
          </div>
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------- where the time went

/** "21 calls, 128 ms in total" when the calls overlapped, so their summed time is more than the wall-clock time shown. */
function callsNote(calls: number, sumUs: number, shownUs: number): string | null {
  if (calls < 2 || sumUs <= shownUs) return null;
  return `${calls} calls, ${fmtUs(sumUs)} in total`;
}

function TimeSplitBar({ tree, head, colour }: { tree: RequestTree; head: Hop; colour: string }) {
  const s = tree.split;
  if (!s || s.totalUs <= 0) return null;
  const parts: Array<{ key: string; us: number; label: ReactNode; bg: string; note?: string | null }> = [
    { key: "own", us: s.ownUs, label: <>{head.service}&apos;s own code</>, bg: colour },
    { key: "db", us: s.dbUs, label: "its database", bg: "oklch(var(--muted))", note: callsNote(s.dbCalls, s.dbSumUs, s.dbUs) },
    { key: "cache", us: s.cacheUs, label: "its cache", bg: "oklch(var(--faint))", note: callsNote(s.cacheCalls, s.cacheSumUs, s.cacheUs) },
    { key: "wait", us: s.waitingUs, label: "waiting on other services", bg: "oklch(var(--border-strong))" },
  ].filter((p) => p.us > 0);
  return (
    <div className="mb-4 grid grid-cols-1 items-center gap-x-4 gap-y-[7px] text-xs text-muted md:grid-cols-[auto_minmax(0,1fr)]">
      <span className="text-2xs uppercase tracking-wide text-faint">Where the time went</span>
      <div className="flex h-2.5 gap-0.5 overflow-hidden rounded-[5px]" aria-hidden>
        {parts.map((p) => <i key={p.key} className="block h-full" style={{ width: `${(p.us / s.totalUs) * 100}%`, background: p.bg }} />)}
      </div>
      <div className="flex flex-wrap gap-x-5 gap-y-1 md:col-start-2">
        {parts.map((p) => (
          <span key={p.key} className="inline-flex items-center gap-[7px]">
            <i className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: p.bg }} />
            {p.label} <Mono className="font-medium text-fg">{fmtUs(p.us)}</Mono>
            {p.note ? <span className="text-faint">({p.note})</span> : null}
          </span>
        ))}
      </div>
      {s.backgroundCalls ? (
        <div className="text-faint md:col-start-2">In the background: {s.backgroundCalls} {s.backgroundCalls === 1 ? "call" : "calls"}, {fmtUs(s.backgroundUs)}</div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------- the path

/** "Show me this repeated call": the hop, and a counter so asking twice scrolls again. */
interface RepeatFocus {
  hopId: HopId;
  seq: number;
}

interface RowCtx {
  /** Each repeated call's group (BAC-68). */
  repeatOf: ReadonlyMap<HopId, RepeatGroup>;
  /** Each call that could run together with its siblings (BAC-71). */
  parallelOf: ReadonlyMap<HopId, ParallelCandidate>;
  focus: RepeatFocus | null;
  tree: RequestTree;
  colours: Map<string, string>;
  now: number;
  openHop: string | null;
  setOpenHop: (id: string | null) => void;
  logsState: LogsState;
  traceId: string;
  axisStart: number;
  axisMs: number;
}

function ticks(axisMs: number): Array<{ at: number; label: string }> {
  const steps = [1, 1.5, 2, 2.5, 5];
  let step = axisMs;
  outer: for (let exp = -3; exp < 9; exp++) {
    for (const m of steps) {
      const s = m * 10 ** exp;
      if (axisMs / s <= 4) { step = s; break outer; }
    }
  }
  const out: Array<{ at: number; label: string }> = [];
  for (let v = 0; v <= axisMs + 1e-9; v += step) {
    const label = v === 0 ? "0" : v >= 1000 ? `${+(v / 1000).toFixed(2)} s` : `${+v.toFixed(2)} ms`;
    out.push({ at: (v / axisMs) * 100, label });
  }
  return out;
}

const GRID = "md:grid md:grid-cols-[minmax(0,1fr)_44px_96px_84px_minmax(200px,330px)] md:gap-x-3 md:items-center";

/** The calls drawn inside a folded group: their group row carries the repeat finding. */
function groupedHops(nodes: readonly PathNode[]): Set<HopId> {
  const out = new Set<HopId>();
  const visit = (n: PathNode): void => {
    for (const m of n.members ?? []) out.add(m.hopId);
    n.kids.forEach(visit);
  };
  nodes.forEach(visit);
  return out;
}

/** A group of repeated calls drawn as one hop: from the first start to the last end. */
function groupSpan(members: readonly Hop[]): Hop {
  const first = members[0];
  const start = Math.min(...members.map((m) => m.startMs));
  const end = Math.max(...members.map((m) => m.endMs ?? m.startMs));
  return { ...first, startMs: start, endMs: end, durationUs: Math.round((end - start) * 1000), children: [], gaps: [], unrecorded: [] };
}

function PathCard({ ctx }: { ctx: RowCtx }) {
  const anyOpen = ctx.tree.hops.some((h) => h.state !== HopState.Finished);
  const nodes = useMemo(() => buildPathNodes(ctx.tree.roots), [ctx.tree]);
  // What the viewer opened or folded by hand; everything else follows the defaults (CP-26).
  const [overrides, setOverrides] = useState<ReadonlyMap<string, boolean>>(new Map());
  const headUs = headHop(ctx.tree)?.durationUs ?? 0;
  const visible = visibleRows(nodes, overrides, headUs);
  const foldable = useMemo(() => expandableKeys(nodes), [nodes]);
  const inGroup = useMemo(() => groupedHops(nodes), [nodes]);
  const allOpen = foldable.length > 0 && foldable.every((k) => visible.some((r) => r.node.key === k && r.expanded));
  const toggle = (key: string, open: boolean): void => setOverrides((m) => new Map(m).set(key, open));
  // The header's "N repeated calls": open the rows down to the first group, then bring it into view.
  const { focus, setOpenHop } = ctx;
  useEffect(() => {
    if (!focus) return;
    const keys = pathKeysTo(nodes, focus.hopId);
    if (!keys) return;
    setOverrides((m) => {
      const next = new Map(m);
      for (const k of keys) next.set(k, true);
      return next;
    });
    const last = keys[keys.length - 1];
    if (last === focus.hopId) setOpenHop(focus.hopId);
    const frame = requestAnimationFrame(() => {
      document.querySelector(`[data-path-key="${last}"]`)?.scrollIntoView({ block: "center", behavior: "smooth" });
    });
    return () => cancelAnimationFrame(frame);
  }, [focus, nodes, setOpenHop]);
  const setAll = (open: boolean): void => setOverrides(new Map(foldable.map((k) => [k, open])));
  const rows: ReactNode[] = [];
  for (const row of visible) {
    const hop = row.node.hop;
    if (row.tail) {
      const open = visible.some((r) => !r.tail && r.node === row.node && r.expanded);
      for (const u of open ? hop.unrecorded : []) {
        rows.push(
          <GapRow key={`u-${hop.hopId}-${u.store}`} depth={row.depth + 1} note
            title={`${plural(u.calls, u.store === StoreKind.Db ? "more database call" : "more cache call", u.store === StoreKind.Db ? "more database calls" : "more cache calls")}`}
            text={`not recorded one by one · ${fmtUs(u.us)} in all`} icon={u.store === StoreKind.Db ? <Database className="h-3.5 w-3.5 text-faint" /> : <Zap className="h-3.5 w-3.5 text-faint" />} />,
        );
      }
      for (const g of hop.gaps) {
        if (g.kind === GapKind.NoReceiver) {
          rows.push(
            <GapRow key={`nr-${hop.hopId}`} depth={row.depth + 1} title={`${g.label}.`}
              text={hop.via === Via.Job ? "The job was not picked up, or its worker does not report hops." : "The receiver does not report hop records, or the call never arrived."} />,
          );
        }
      }
      continue;
    }
    for (const g of hop.gaps) {
      if (g.kind === GapKind.OutsideCaller) rows.push(<GapRow key={`oc-${hop.hopId}`} depth={row.depth} note title="Called from outside this organisation." text="The caller's records are not here: it belongs to another organisation, or its records were not collected." icon={<LogIn className="h-3.5 w-3.5 shrink-0 text-faint" />} />);
      if (g.kind === GapKind.TracerBetween) rows.push(<GapRow key={`tb-${hop.hopId}`} depth={row.depth} title="Passed through a tracer-only service." text="A service that sends spans but no hop records sat between these two hops." note />);
    }
    rows.push(<HopRow key={row.node.key} row={row} ctx={ctx} grouped={inGroup.has(hop.hopId)} onFold={(open) => toggle(row.node.key, open)} />);
    if (!row.node.members && ctx.openHop === hop.hopId) rows.push(<HopDetail key={`d-${hop.hopId}`} hop={hop} call={row.node.call} depth={row.depth} ctx={ctx} />);
  }
  const dbHost = sharedDatabaseHost(ctx.tree.hops);
  return (
    <Card className="relative">
      <div data-card-head className="flex min-h-11 items-center justify-between gap-x-3 border-b border-border px-4 py-1.5">
        <CardHeadText title="Path" sub="Every hop this request made, parent to child" className="hidden md:flex md:min-w-[8rem]" />
        {foldable.length > 0 ? (
          <button type="button" onClick={() => setAll(!allOpen)} className="shrink-0 rounded-md border border-border px-2 py-1 text-2xs font-medium text-muted transition-colors hover:bg-surface-2 hover:text-fg">
            {allOpen ? "Fold all" : "Open all"}
          </button>
        ) : null}
        {/* the legend stays one row (scrolls sideways when it holds many services) so the header stays one row */}
        <div className="scroll-thin flex min-w-0 max-w-full items-center gap-x-3.5 overflow-x-auto whitespace-nowrap text-2xs text-muted">
          {ctx.tree.services.map((s) => (
            <span key={s} className="inline-flex items-center gap-1.5"><Dot colour={ctx.colours.get(s) as string} />{s}</span>
          ))}
          {dbHost ? (
            <span className="inline-flex min-w-0 items-center gap-1.5"><Database className="h-3 w-3 shrink-0 text-faint" /><span>database</span><Mono className="min-w-0 truncate text-fg">{dbHost}</Mono></span>
          ) : null}
          {anyOpen ? (
            <>
              <span className="inline-flex items-center gap-1.5"><i className="inline-block h-2 w-[18px] rounded-sm bg-muted" />finished</span>
              <span className="inline-flex items-center gap-1.5"><i className="inline-block h-2 w-[18px] rounded-sm" style={HATCH("oklch(var(--muted))")} />no end record</span>
            </>
          ) : null}
        </div>
      </div>
      <div className={cn("hidden min-h-8 border-b border-border px-4 text-2xs font-medium uppercase tracking-wide text-faint", GRID)}>
        <div>Hop</div><div>Via</div><div>Status</div><div className="text-right">Took</div>
        <div className="relative h-4 font-mono text-[10.5px] font-normal normal-case tracking-normal">
          {ticks(ctx.axisMs).map((t, i, all) => (
            <span key={t.label} className="absolute top-0 whitespace-nowrap" style={{ left: `${t.at}%`, transform: i === 0 ? "none" : i === all.length - 1 && t.at > 92 ? "translateX(-100%)" : "translateX(-50%)" }}>{t.label}</span>
          ))}
        </div>
      </div>
      <div className="py-0.5 md:py-0 [&>*:last-child]:border-b-0">{rows}</div>
    </Card>
  );
}

function GapRow({ depth, title, text, note = false, icon }: { depth: number; title: string; text: string; note?: boolean; icon?: ReactNode }) {
  return (
    <div className="border-b border-border px-3.5 py-2 md:px-4" style={{ paddingLeft: undefined }}>
      <div
        className="flex items-start gap-[9px] rounded-lg border border-dashed border-border-strong px-3 py-2 text-[12.5px] leading-[1.45] text-muted md:items-center"
        style={{ marginLeft: `calc(${depth} * var(--hop-indent, 18px))` }}
      >
        {icon ?? <Unplug className={cn("mt-0.5 h-3.5 w-3.5 shrink-0 md:mt-0", note ? "text-faint" : "text-warn")} />}
        <span><b className="font-semibold text-fg">{title}</b> {text}</span>
      </div>
    </div>
  );
}

function HopText({ hop, ctx, waited }: { hop: Hop; ctx: RowCtx; waited: string | null }) {
  const method = hop.isStore ? null : hop.method;
  const label = hop.dir === HopDir.In ? hop.op ?? hop.via : hop.isStore ? storeLabel(hop) : outLabel(hop);
  const inline = statementTail(hop);
  return (
    <>
      <IoTag dir={hop.dir} />
      <Dot colour={ctx.colours.get(hop.service) as string} />
      {hop.dir === HopDir.In ? <b className="shrink-0 font-semibold">{hop.service}</b> : null}
      {hop.isStore ? storeIcon(hop.via, "h-[13px] w-[13px] shrink-0 text-faint") : null}
      <Mono className={cn("min-w-0 truncate text-[12.5px]", inline && "shrink-0")}>
        {method ? <span className="font-medium text-faint">{method} </span> : null}
        {label}
      </Mono>
      {inline ? (
        <Mono className="min-w-0 truncate text-[12px] text-faint" title={hop.stmt ?? undefined}>{inline}</Mono>
      ) : null}
      {waited ? <span className="shrink-0 text-2xs text-faint" title="Waited for a database connection">{waited}</span> : null}
    </>
  );
}

/** The words on a merged call row: what the callee spent and what the network added. */
function callNote(call: Hop, hop: Hop): string {
  if (call.durationUs === null || hop.durationUs === null) return "";
  const net = call.durationUs - hop.durationUs;
  return net > 0 ? `handled in ${fmtUs(hop.durationUs)} · network ${fmtUs(net)}` : "";
}

function FoldButton({ row, onFold }: { row: VisibleRow; onFold: (open: boolean) => void }) {
  if (!row.expandable) return <span className="inline-block h-[14px] w-[14px] shrink-0" aria-hidden />;
  const Icon = row.expanded ? ChevronDown : ChevronRight;
  return (
    <button
      type="button"
      aria-expanded={row.expanded}
      aria-label={row.expanded ? "Fold what this hop made" : "Show what this hop made"}
      onClick={(e) => { e.stopPropagation(); onFold(!row.expanded); }}
      onKeyDown={(e) => e.stopPropagation()}
      className="inline-flex h-[14px] w-[14px] shrink-0 items-center justify-center rounded text-muted hover:bg-surface-2 hover:text-fg"
    >
      <Icon className="h-3.5 w-3.5" />
    </button>
  );
}

function HopRow({ row, ctx, onFold, grouped }: { row: VisibleRow; ctx: RowCtx; onFold: (open: boolean) => void; grouped: boolean }) {
  const { node, depth } = row;
  const hop = node.hop;
  const members = node.members;
  // A merged pair is drawn with the caller's timing (what the caller waited); a group as one span.
  const timed: Hop = members ? groupSpan(members) : node.call ?? hop;
  // A group row carries its finding; a call inside an open group does not repeat it.
  const repeat = members ? members.map((m) => ctx.repeatOf.get(m.hopId)).find((g) => g !== undefined) ?? null : grouped ? null : ctx.repeatOf.get(hop.hopId) ?? null;
  const parallel = members ? null : ctx.parallelOf.get(node.call?.hopId ?? hop.hopId) ?? null;
  const status = statusOf(hop);
  const note = [node.call ? callNote(node.call, hop) : "", members ? `${members.length} calls · ${fmtUs(rowUs(node))} in all` : noteOf(hop), !members && repeat ? repeatNote(repeat) : ""].filter(Boolean).join(" · ");
  const geom = geometry(timed, ctx.axisStart, ctx.axisMs, ctx.now);
  const selected = !members && ctx.openHop === hop.hopId;
  const colour = ctx.colours.get(hop.service) as string;
  const toggle = () => (members ? onFold(!row.expanded) : ctx.setOpenHop(selected ? null : hop.hopId));
  const took = members ? fmtUs(rowUs(node)) : tookText(timed, ctx.now);
  // A group row names its calls' waits added up, never one member's.
  const waited = members ? waitSuffixOf(members) : waitSuffix(hop);
  return (
    <div
      role="button"
      tabIndex={0}
      data-path-key={node.key}
      aria-expanded={selected}
      onClick={toggle}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); } }}
      className={cn("relative cursor-pointer border-b border-border px-3.5 pb-[11px] pt-2.5 hover:bg-surface-2/60 md:min-h-[38px] md:px-4 md:py-0", GRID, selected && "bg-surface-2")}
      style={{ ["--d" as string]: depth } as CSSProperties}
    >
      {/* desktop */}
      <div className="hidden min-w-0 items-center gap-[7px] whitespace-nowrap md:flex" style={{ paddingLeft: depth * 18 }}>
        {depth ? <CornerDownRight className="-ml-[17px] -mr-[3px] h-[13px] w-[13px] shrink-0 text-border-strong" /> : null}
        <FoldButton row={row} onFold={onFold} />
        <HopText hop={hop} ctx={ctx} waited={waited} />
        {members ? <span className="shrink-0 font-mono text-[12px] font-medium text-muted">×{members.length}</span> : null}
        {repeat ? <RepeatChip group={repeat} /> : null}
        {parallel ? <ParallelChip candidate={parallel} /> : null}
        {note ? <span className="min-w-0 truncate text-2xs text-faint">{note}</span> : null}
        {row.summary && !members ? <span className="min-w-0 shrink-0 truncate rounded-full bg-surface-2 px-2 py-px text-2xs text-muted">{row.summary}</span> : null}
      </div>
      <div className="hidden font-mono text-[11.5px] text-faint md:block">{hop.via}</div>
      <div className="hidden md:block"><Badge tone={status.tone}>{status.text}</Badge></div>
      <div className="hidden text-right font-mono text-[12.5px] tabular-nums md:block">{took}</div>
      <div className="hidden md:block"><Bar hop={timed} colour={colour} geom={geom} /></div>
      {/* phone: the hop stacks and keeps its own time bar under its text */}
      <div className="md:hidden" style={{ paddingLeft: depth * 12 }}>
        <div className="flex min-w-0 items-center gap-[7px] text-[12.5px]">
          <FoldButton row={row} onFold={onFold} />
          <IoTag dir={hop.dir} />
          <Dot colour={colour} />
          <span className="min-w-0 [overflow-wrap:anywhere]">
            {hop.dir === HopDir.In ? <b className="font-semibold">{hop.service} </b> : null}
            <Mono className="text-xs">{hop.isStore ? storeLabel(hop) : `${hop.method ? `${hop.method} ` : ""}${hop.dir === HopDir.In ? hop.op ?? hop.via : outLabel(hop)}`}</Mono>
          </span>
          {status.text === "stopped here" ? <span className="ml-auto shrink-0"><Badge tone="err">stopped here</Badge></span> : null}
        </div>
        {statementTail(hop) ? (
          <div className="ml-[34px] mt-[3px] font-mono text-[11.5px] leading-snug text-faint [overflow-wrap:anywhere]" title={hop.stmt ?? undefined}>{statementTail(hop)}</div>
        ) : null}
        <div className="mb-[7px] ml-[34px] mt-[3px] font-mono text-2xs text-faint">
          {[hop.via, members ? `${members.length} calls` : null, waited, hop.error ?? (hop.state === HopState.Finished ? hop.status ?? hop.outcome : hop.gaps.some((g) => g.kind === GapKind.Stopped) ? "no end record" : "open"), took, members ? null : row.summary, repeat ? (members ? repeatChip(repeat) : repeatNote(repeat)) : null, parallel ? PARALLEL_CHIP : null].filter(Boolean).join(" · ")}
        </div>
        <Bar hop={timed} colour={colour} geom={geom} thin />
      </div>
    </div>
  );
}

function HopDetail({ hop, call = null, depth, ctx }: { hop: Hop; call?: Hop | null; depth: number; ctx: RowCtx }) {
  const facts: Array<[string, ReactNode]> = [
    ["Hop", hop.hopId],
    ...(call ? ([["Called as", `${outLabel(call)} · the caller waited ${tookText(call, ctx.now)}`]] as Array<[string, ReactNode]>) : []),
    ["Parent", hop.parentHop ?? "none"],
    ["Adapter", hop.adapter ?? "not reported"],
    ["Started", <Clock key="s" ts={hop.startMs} />],
    ["Ended", hop.endMs !== null ? <Clock key="e" ts={hop.endMs} /> : "no end record"],
  ];
  if (hop.isStore && hop.via === Via.Db) {
    if (hop.peer) facts.push(["Database", hop.peer]);
    if (hop.table) facts.push(["Table", hop.table]);
  }
  if (hop.isStore) facts.push(...storeCallFacts(hop));
  const repeat = ctx.repeatOf.get(hop.hopId);
  if (repeat) {
    facts.push(["Repeated", repeatSentence(repeat)]);
    const hint = repeatHint(repeat);
    if (hint) facts.push(["Suggestion", hint]);
  }
  const parallel = ctx.parallelOf.get(call?.hopId ?? hop.hopId);
  if (parallel) facts.push(["Could run together", parallelSentence(parallel)]);
  if (hop.pipeline) facts.push(["Commands", `${hop.pipeline.ops.join(", ")} · sent as one MULTI block`]);
  if (hop.skewMs > 0) facts.push(["Start", `drawn from its caller's start: its records put it ${fmtGap(hop.skewMs)} earlier`]);
  if (hop.handoff) facts.push(["Made", "in the background (handoff)"]);
  else if (hop.afterResponse) facts.push(["Note", "ended after the response"]);
  if (hop.attempt !== null) facts.push(["Attempt", String(hop.attempt)]);
  if (hop.error) facts.push(["Failure", hop.error]);
  const storeChip = storeTotalsChips(hop.totals);
  const hasFields = hop.fields.length || hop.linkedIds.length || storeChip.length;
  const stopped = hop.gaps.some((g) => g.kind === GapKind.Stopped);
  const lineService = hop.service;
  return (
    <div
      className="border-b border-border bg-surface-2 px-3.5 pb-3.5 pt-3 md:pr-4"
      style={{ paddingLeft: undefined }}
    >
      <div style={{ marginLeft: `max(0px, calc(${depth} * 18px + 34px))` }} className="max-md:!ml-0">
        <div className="flex flex-wrap gap-x-5 gap-y-1 text-[11.5px] text-muted">
          {facts.map(([k, v]) => <span key={k} className="min-w-0"><em className="not-italic text-faint">{k}</em> <Mono className="font-medium text-fg [overflow-wrap:anywhere]">{v}</Mono></span>)}
        </div>
        {hop.stmt ? (
          <div className="mt-2.5">
            <div className="text-[11.5px] text-faint">Statement <span className="text-faint/80">(values replaced by ?)</span></div>
            <pre className="mt-1 whitespace-pre-wrap rounded-lg border border-border bg-bg px-3 py-2 font-mono text-xs leading-relaxed text-fg [overflow-wrap:anywhere]">{hop.stmt}</pre>
          </div>
        ) : null}
        {hasFields ? (
          <div className="mt-[9px] flex flex-wrap items-center gap-1.5">
            <span className="mr-0.5 text-[11.5px] text-faint">Fields</span>
            {hop.fields.map((f) => <Chip key={`f-${f.name}`} k={f.name} v={f.value} />)}
            {hop.linkedIds.map((l) => <Chip key={`l-${l.name}-${l.value}`} k={l.name} v={l.value} icon={<Link2 className="h-3 w-3 text-faint" />} />)}
            {storeChip.map((s) => (
              <span key={s} className="inline-flex items-center gap-1.5 rounded-[5px] border border-border bg-bg px-[7px] py-0.5 font-mono text-[11.5px] font-medium text-muted">
                <Database className="h-3 w-3 text-faint" />{s}
              </span>
            ))}
          </div>
        ) : null}
        <DetailLines hop={hop} ctx={ctx} />
        {stopped && ctx.logsState === LogsState.Ready ? <div className="mt-2 text-xs italic text-muted">Nothing more from {lineService} for this request.</div> : null}
        <Link
          to={`/logs?service=${encodeURIComponent(lineService)}&q=${ctx.traceId}&range=24h`}
          className="mt-2.5 inline-flex items-center gap-[5px] text-2xs font-medium text-brand"
        >
          Open these lines in Logs <ArrowRight className="h-[13px] w-[13px]" />
        </Link>
      </div>
    </div>
  );
}

function Chip({ k, v, icon }: { k: string; v: string; icon?: ReactNode }) {
  return (
    <span className="inline-flex max-w-full items-center gap-1.5 rounded-[5px] border border-border bg-bg px-[7px] py-0.5 font-mono text-[11.5px] font-medium text-fg">
      {icon}<em className="not-italic text-faint">{k}</em><span className="[overflow-wrap:anywhere]">{v}</span>
    </span>
  );
}

const LEVEL_CLASS: Record<string, string> = { warn: "text-warn", error: "text-err", fatal: "text-err" };

function DetailLines({ hop, ctx }: { hop: Hop; ctx: RowCtx }) {
  const box = "mt-2.5 rounded-lg border border-border bg-bg px-3 py-2 font-mono text-xs leading-[1.75]";
  if (hop.isStore) return null;
  if (ctx.logsState === LogsState.Loading) {
    return <div className={box} aria-busy="true"><Skeleton className="my-1 h-3.5 w-3/4 animate-pulse" /><Skeleton className="my-1 h-3.5 w-1/2 animate-pulse" /></div>;
  }
  if (ctx.logsState === LogsState.Failed) return <div className={cn(box, "text-err")}>Log lines unavailable: the log store did not answer.</div>;
  if (!hop.logs.length) return <div className={cn(box, "text-muted")}>No log lines from {hop.service} during this hop carry the trace ID.</div>;
  const shown = hop.logs.slice(0, 200);
  return (
    <div className={box}>
      {shown.map((l, i) => (
        <div key={i} className="grid grid-cols-[96px_40px_minmax(0,1fr)] gap-2.5 max-md:grid-cols-[auto_minmax(0,1fr)] max-md:gap-x-2.5">
          <span className="text-faint"><Clock ts={l.timeMs} /></span>
          <span className={cn("text-[11px] font-medium text-muted", LEVEL_CLASS[l.level ?? ""])}>{l.level ?? ""}</span>
          <span className="min-w-0 whitespace-pre-wrap [overflow-wrap:anywhere] max-md:col-span-2">{l.line}</span>
        </div>
      ))}
      {hop.logs.length > shown.length ? <div className="text-faint">{hop.logs.length - shown.length} more lines in Logs</div> : null}
    </div>
  );
}

// ---------------------------------------------------------------- no hop records

function LogsOnly({ d }: { d: Data }) {
  return (
    <Deferred
      resolve={d.onlyLogs}
      fallback={<SearchingNote text={`No hop records in ${WINDOW_LABEL.retention}. Searching log lines for ${WINDOW_LABEL.day}…`} />}
    >
      {(settled: Settled<TraceLogLine[] | null>) => {
        if (!settled.ok) return <LookupFailed />;
        const list = settled.value ?? [];
        if (!list.length) {
          return (
            <Card>
              <div className="px-4 py-12 text-center">
                <div className="mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-xl bg-surface-2 text-faint"><SearchX className="h-5 w-5" /></div>
                <p className="text-sm font-medium text-fg">Nothing found for this ID</p>
                <p className="mx-auto mt-1 max-w-[56ch] text-[13px] text-muted">
                  Searched hop records for the last {HOP_RETENTION_DAYS} days and log lines for the last 24 hours. Log lines are kept {LOG_RETENTION_DAYS} days.
                  <span className="mt-1 block font-mono text-xs text-faint [overflow-wrap:anywhere]">{d.traceId}</span>
                </p>
              </div>
            </Card>
          );
        }
        const byService = new Map<string, TraceLogLine[]>();
        for (const l of list) byService.set(l.service, [...(byService.get(l.service) ?? []), l]);
        return (
          <>
            <div data-content className="mb-4">
              <h1 className="m-0 font-mono text-[21px] font-semibold tracking-tight [overflow-wrap:anywhere]">{d.traceId}</h1>
              <p className="mt-2 text-[12.5px] text-muted">
                No hop records for this ID, so there is no path. These are the log lines that carry it, by service, in time order.
                Services show a path once Correlator writes hop records.
              </p>
            </div>
            <Card>
              {[...byService.entries()].map(([service, ls]) => (
                <div key={service} className="border-b border-border px-4 py-3 last:border-b-0">
                  <div className="mb-1 font-mono text-[12.5px] text-accent">{service} <span className="text-faint">· {ls.length} lines</span></div>
                  <div className="font-mono text-xs leading-[1.75]">
                    {ls.map((l, i) => (
                      <div key={i} className="grid grid-cols-[96px_40px_minmax(0,1fr)] gap-2.5 max-md:grid-cols-[auto_minmax(0,1fr)] max-md:gap-x-2.5">
                        <span className="text-faint"><Clock ts={l.timeMs} /></span>
                        <span className={cn("text-[11px] text-muted", LEVEL_CLASS[l.level ?? ""])}>{l.level ?? ""}</span>
                        <span className="min-w-0 whitespace-pre-wrap [overflow-wrap:anywhere] max-md:col-span-2">{l.line}</span>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </Card>
          </>
        );
      }}
    </Deferred>
  );
}

export function ErrorBoundary() {
  // Only the loader's 404 means the address is not a trace ID; anything else is a failure to load it.
  const error = useRouteError();
  const notAnId = isRouteErrorResponse(error) && error.status === 404;
  return (
    <Card>
      <div className="px-4 py-12 text-center">
        <p className="text-sm font-medium text-fg">{notAnId ? "Not a trace ID" : "This request could not be loaded"}</p>
        <p className="mx-auto mt-1 max-w-[48ch] text-[13px] text-muted">
          {notAnId
            ? "A request address holds 32 hex characters. Paste any ID into the search box at the top to open its request."
            : "The page failed while loading it. Reload to try again."}
        </p>
      </div>
    </Card>
  );
}
