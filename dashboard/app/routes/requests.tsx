import type { LoaderFunctionArgs } from "@remix-run/node";
import { defer, json } from "@remix-run/node";
import { useFetcher, useLoaderData, useNavigation, useSearchParams, type ShouldRevalidateFunctionArgs } from "@remix-run/react";
import { Link, useCurrentEnv, useEnvNavigate } from "~/components/env-link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Network, Search, X } from "lucide-react";
import { Badge, Card, CardHead, Empty, ErrorNote, PageTitle, Skeleton } from "~/components/ui";
import { Deferred, RowsSkeleton } from "~/components/defer";
import { safe } from "~/lib/config.server";
import { requireScope } from "~/lib/env.server";
import { inboundHttpTotals, inboundServices, type InboundTotals } from "~/lib/hops/metrics.server";
import { hopRequestPage, type HopPage, type RequestListRow } from "~/lib/hops/requests.server";
import { pathTitle } from "~/lib/hops/paths";
import { HEALTH_PARAM, HEALTH_TOGGLE_LABEL, HEALTH_TOGGLE_SHORT, HealthChecks, MONITOR_BADGE, MONITOR_TITLE } from "~/lib/hops/health";
import {
  ALL_METHODS,
  ALL_SERVICES,
  BEFORE_PARAM,
  DEFAULT_RANGE,
  REQUEST_RANGES,
  STATUS_FILTERS,
  SortDir,
  SortKey,
  StatusFilter,
  isRequestRange,
  onlyClientFiltersChanged,
  parseRequestFilters,
  resultSetKey,
  withRequestFilters,
  RequestParam,
  type RequestFilters,
  type RequestRange,
} from "~/lib/request-filters";
import { withEnv } from "~/lib/env";
import { matchesRequestText } from "~/lib/hops/request-filter";
import { CHATTY_BADGE, byMostCalls, chattyRows, chattySentence, type ChattyVerdict } from "~/lib/hops/chatty";
import { cn, fmtMs, fmtPct } from "~/lib/utils";
import { listPinsPage } from "~/lib/pins.server";
import { parsePinCursor, type PinPage } from "~/lib/pins";
import { PINNED_PARAM, PinnedChip, PinnedList } from "~/components/insights/pinned-list";
import { Clock } from "~/components/time";

/** Typing in the search box writes the URL after this pause (replace, so history is not flooded). */
const SEARCH_DEBOUNCE_MS = 300;

interface FeedData {
  rows: RequestListRow[];
  next: number | null;
  error: string | null;
}

export async function loader({ request }: LoaderFunctionArgs) {
  const { ctx, tenant: t } = await requireScope(request);
  const url = new URL(request.url);
  // BAC-90: one parser for the URL; the server reads the filters that choose what is loaded.
  const filters = parseRequestFilters(url.searchParams);
  const requested = filters.service;
  const rangeKey: RequestRange = filters.range;
  const hrs = REQUEST_RANGES[rangeKey];
  const sinceMs = Date.now() - hrs * 3600_000;
  const beforeRaw = Number(url.searchParams.get(BEFORE_PARAM));
  const health = filters.health;

  // The Pinned view (BAC-78): pinned requests from Postgres instead of the live feed.
  if (url.searchParams.get(PINNED_PARAM) === "1") {
    const cursor = parsePinCursor(url.searchParams.get(BEFORE_PARAM));
    if (cursor) {
      const page = await safe(() => listPinsPage(ctx.org.id, cursor), { rows: [], next: null } as PinPage);
      return json({ kind: "pinned-older" as const, page: page.data, error: page.error });
    }
    const pins = safe(() => listPinsPage(ctx.org.id), { rows: [], next: null } as PinPage);
    return defer({ kind: "pinned" as const, pins });
  }

  const services = await safe(() => inboundServices(t), [] as string[]);
  const list = services.data;
  const chosen = requested === ALL_SERVICES ? ALL_SERVICES : list.includes(requested) ? requested : ALL_SERVICES;
  const hopService = chosen === ALL_SERVICES ? null : chosen;

  // "Load older requests": the next 100 hop rows before the cursor (design 13).
  if (Number.isFinite(beforeRaw) && beforeRaw > 0) {
    const page = await safe(() => hopRequestPage(t, { service: hopService, sinceMs, before: beforeRaw, health }), { rows: [], next: null } as HopPage);
    return json({ kind: "older" as const, page: page.data, error: page.error });
  }

  const feed: Promise<FeedData> = safe(
    () => hopRequestPage(t, { service: hopService, sinceMs, before: Date.now(), health }),
    { rows: [], next: null } as HopPage
  ).then((hops) => ({ rows: hops.data.rows, next: hops.data.next, error: hops.error }));
  const totals: Promise<{ data: InboundTotals | null; error: string | null }> = safe(() => inboundHttpTotals(rangeKey, hopService, t, undefined, health), null);

  return defer({
    kind: "page" as const,
    env: t.project ?? null,
    services: list,
    service: chosen,
    range: rangeKey,
    health,
    feed,
    totals,
  });
}

/** Search, route, status, method, sort and "chatty only" narrow the rows already loaded (BAC-90):
 *  changing only those updates the URL without asking the server again. The header's 10 s poll
 *  and every other change still reload. */
export function shouldRevalidate({ currentUrl, nextUrl, formMethod, defaultShouldRevalidate }: ShouldRevalidateFunctionArgs): boolean {
  if (formMethod && formMethod.toUpperCase() !== "GET") return defaultShouldRevalidate;
  if (currentUrl.pathname === nextUrl.pathname && onlyClientFiltersChanged(currentUrl.searchParams, nextUrl.searchParams)) return false;
  return defaultShouldRevalidate;
}

function statusTone(s: number | null) {
  if (s === null) return "text-muted";
  if (s >= 500) return "text-err";
  if (s >= 400) return "text-warn";
  if (s >= 300) return "text-info";
  return "text-ok";
}
function cls(s: number | null) {
  if (s === null) return "none";
  return `${Math.floor(s / 100)}xx`;
}
function pctl(nums: number[], p: number) {
  if (!nums.length) return 0;
  const a = [...nums].sort((x, y) => x - y);
  return a[Math.min(a.length - 1, Math.max(0, Math.ceil((p / 100) * a.length) - 1))];
}

const FILTERS = STATUS_FILTERS;

/** One list row's identity, as the dedupe uses it. */
const rowKey = (r: RequestListRow): string => `${r.traceID}|${r.service}|${r.startMs}`;

const SELECT = "h-9 w-full max-w-full sm:w-auto rounded-lg border border-border bg-surface px-3 text-[13px] outline-none focus:border-brand/40";

export default function Requests() {
  const d = useLoaderData<typeof loader>();
  if (d.kind === "pinned") {
    return (
      <div className="space-y-4 animate-fade-in">
        <PageTitle title="Requests" sub="Requests pinned by hand or kept automatically, newest first." right={<PinnedChip on />} />
        <Deferred resolve={d.pins} fallback={<Card><CardHead title="Pinned requests" sub="kept after their records expire" /><RowsSkeleton rows={6} /></Card>}>
          {(p) => <PinnedList first={p.data} error={p.error} />}
        </Deferred>
      </div>
    );
  }
  if (d.kind !== "page") return null;
  const hasServices = d.services.length > 0;
  return (
    <div className="space-y-4 animate-fade-in">
      <PageTitle title="Requests" sub="A live feed of individual requests across your services: method, route, status and latency." right={<PinnedChip on={false} />} />
      {!hasServices ? (
        <Card>
          <div className="flex flex-col items-center px-6 py-14 text-center">
            <span className="grid h-11 w-11 place-items-center rounded-xl bg-surface-2 text-faint"><Network className="h-5 w-5" /></span>
            <p className="mt-4 text-sm font-medium">No services report requests yet</p>
            <p className="mt-1 max-w-[56ch] text-[13px] text-muted">Requests appear here once a service runs Correlator with hop records on and its host runs the backwork collector or agent.</p>
          </div>
        </Card>
      ) : (
        <Deferred
          resolve={d.feed}
          fallback={
            <>
              <div className="grid grid-cols-3 gap-3">
                {[0, 1, 2].map((i) => <Card key={i} className="px-4 py-3.5"><Skeleton className="h-3 w-16" /><Skeleton className="mt-2 h-6 w-20" /></Card>)}
              </div>
              <Card><CardHead title="Recent requests" sub={`${d.service === ALL_SERVICES ? "all services" : d.service} · last ${d.range}`} /><RowsSkeleton rows={8} /></Card>
            </>
          }
        >
          {/* No remount key (BAC-90): the filters live in the URL, and Feed resets its older rows itself when the result set changes. */}
          {(feed) => <Feed feed={feed} totals={d.totals} services={d.services} service={d.service} range={d.range} health={d.health} env={d.env} />}
        </Deferred>
      )}
    </div>
  );
}

function Feed({
  feed,
  totals,
  services,
  service,
  range,
  health,
  env,
}: {
  feed: FeedData;
  totals: Promise<{ data: InboundTotals | null; error: string | null }>;
  services: string[];
  service: string;
  range: RequestRange;
  health: HealthChecks;
  env: string | null;
}) {
  const navigate = useEnvNavigate();
  const currentEnv = useCurrentEnv();
  // BAC-90: the URL is the only store of the filters. Discrete choices push a history entry;
  // the search box replaces it (debounced) so typing does not flood history.
  const [params, setParams] = useSearchParams();
  const filters = useMemo(() => parseRequestFilters(params), [params]);
  // While a change that reloads (service, range, health checks) is loading, the controls already
  // show the new choice: Remix's pending location, else the committed one.
  const pending = useNavigation().location;
  const shownSearch = pending && pending.pathname === "/requests" ? pending.search : null;
  const shown = useMemo<RequestFilters>(() => {
    const f = shownSearch !== null ? parseRequestFilters(new URLSearchParams(shownSearch)) : filters;
    // A service the server does not know reads as "all", as the loader does.
    return f.service !== ALL_SERVICES && !services.includes(f.service) ? { ...f, service: service } : f;
  }, [shownSearch, filters, services, service]);
  const { status: statusFilter, method, q, route: exactRoute, sort, chatty: chattyOnly } = filters;
  // Changes build on the newest intended URL, not on the one this render saw: a click made while
  // another change is still loading, or a search written after its debounce, must not undo it.
  const liveParams = useRef(params);
  liveParams.current = params;
  const intended = useRef<URLSearchParams | null>(null);
  useEffect(() => {
    intended.current = null; // a committed location is the truth again (also after back/forward)
  }, [params]);
  const update = useCallback(
    (patch: Partial<RequestFilters>, replace = false) => {
      const base = intended.current ?? liveParams.current;
      // The environment being shown is written too when the URL did not name it yet, so the
      // address always restores (and shares) exactly this view.
      const next = withRequestFilters(base, { ...(base.has(RequestParam.Env) || !currentEnv ? {} : { env: currentEnv }), ...patch });
      intended.current = next;
      setParams(next, { replace, preventScrollReset: true });
    },
    [setParams, currentEnv],
  );
  const setStatusFilter = (s: StatusFilter): void => update({ status: s });
  const setMethod = (m: string): void => update({ method: m });
  const setChattyOnly = (on: boolean): void => update({ chatty: on });
  const toggleSort = (key: SortKey): void =>
    update({ sort: sort.key === key ? { key, dir: sort.dir === SortDir.Asc ? SortDir.Desc : SortDir.Asc } : { key, dir: SortDir.Desc } });
  const setSearch = (v: string): void => update({ q: v, route: null }, true);
  const clearSearch = (): void => update({ q: "", route: null });

  // Older pages are appended in place; the live poll refreshes only the newest page.
  const older = useFetcher<typeof loader>();
  const [olderRows, setOlderRows] = useState<RequestListRow[]>([]);
  const [next, setNext] = useState<number | null>(feed.next);
  const [olderError, setOlderError] = useState<string | null>(null);
  // A new result set (environment, service, range or health checks): the older rows belonged to
  // the old one, so they go and paging starts again from the new first page.
  const setKey = resultSetKey({ env, service, range, health });
  const lastSetKey = useRef(setKey);
  /** The result set an "older" page was asked for; a page for another set is never appended. */
  const loadingFor = useRef<string | null>(null);
  useEffect(() => {
    if (lastSetKey.current === setKey) return;
    lastSetKey.current = setKey;
    setOlderRows([]);
    setOlderError(null);
    setNext(feed.next);
  }, [setKey, feed.next]);
  useEffect(() => {
    const data = older.data;
    if (older.state !== "idle" || !data || data.kind !== "older" || loadingFor.current === null) return;
    const forSet = loadingFor.current;
    loadingFor.current = null;
    if (forSet !== lastSetKey.current) return;
    setOlderRows((prev) => [...prev, ...data.page.rows]);
    setNext(data.page.next);
    setOlderError(data.error);
  }, [older.state, older.data]);
  useEffect(() => {
    if (!olderRows.length) setNext(feed.next);
  }, [feed.next, olderRows.length]);

  const all = useMemo(() => {
    const seen = new Set<string>();
    const out: RequestListRow[] = [];
    for (const r of [...feed.rows, ...olderRows]) {
      const k = rowKey(r);
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(r);
    }
    return out;
  }, [feed.rows, olderRows]);

  // Chatty rows (BAC-71): judged against the loaded rows of the same route.
  const chatty = useMemo(() => {
    const verdicts = chattyRows(all);
    return new Map<string, ChattyVerdict>(all.map((r, i) => [rowKey(r), verdicts[i]]));
  }, [all]);
  const chattyCount = useMemo(() => Array.from(chatty.values()).filter((v) => v.chatty).length, [chatty]);

  const methods = useMemo(() => {
    const set = new Set(all.map((r) => r.method).filter(Boolean));
    if (method !== ALL_METHODS) set.add(method);
    return ["all", ...Array.from(set).sort()];
  }, [all, method]);

  const rows = useMemo(() => {
    let r = all;
    if (statusFilter !== StatusFilter.All) r = r.filter((x) => cls(x.status) === statusFilter);
    if (method !== ALL_METHODS) r = r.filter((x) => x.method === method);
    if (chattyOnly) r = r.filter((x) => chatty.get(rowKey(x))?.chatty === true);
    if (exactRoute !== null) r = r.filter((x) => x.route === exactRoute);
    else if (q.trim()) r = r.filter((x) => matchesRequestText(x, q));
    if (sort.key === SortKey.Calls) r = sort.dir === SortDir.Desc ? byMostCalls(r) : [...byMostCalls(r)].reverse();
    else if (sort.key) {
      const m = sort.dir === SortDir.Asc ? 1 : -1;
      const val = (x: RequestListRow) => (sort.key === SortKey.Time ? x.startMs : sort.key === SortKey.Latency ? x.durationMs : x.status ?? 0);
      r = [...r].sort((a, b) => (val(a) - val(b)) * m);
    }
    return r;
  }, [all, statusFilter, method, q, exactRoute, sort, chattyOnly, chatty]);

  // The Domain column (HOP-27) only when a loaded row has a host: older records show no empty column.
  const hasHosts = useMemo(() => all.some((r) => !!r.host), [all]);
  const filtered = statusFilter !== StatusFilter.All || method !== ALL_METHODS || exactRoute !== null || q.trim() !== "" || chattyOnly;
  const chattyControls = (
    <ChattyControls
      count={chattyCount}
      only={chattyOnly}
      onOnly={setChattyOnly}
      mostCalls={sort.key === SortKey.Calls}
      onMostCalls={(on) => update({ sort: on ? { key: SortKey.Calls, dir: SortDir.Desc } : { key: null, dir: SortDir.Desc } })}
    />
  );
  const loadedCounts = useMemo(() => {
    const c: Record<string, number> = { all: all.length };
    for (const f of FILTERS.slice(1)) c[f] = all.filter((r) => cls(r.status) === f).length;
    return c;
  }, [all]);
  const fromRows = useMemo(() => {
    const total = rows.length;
    const errs = rows.filter((r) => r.error || (r.status ?? 0) >= 500).length;
    return { total, errPct: total ? (errs / total) * 100 : 0, p95: pctl(rows.map((r) => r.durationMs), 95) };
  }, [rows]);


  return (
    <>
      {/* summary: range totals from the hop metrics, or the loaded rows when a filter is on */}
      <Deferred resolve={totals} fallback={<SummaryCards total={null} errPct={null} p95={null} />}>
        {(t) => {
          const tot = t.data;
          if (filtered || !tot || tot.total === 0) return <SummaryCards total={fromRows.total} errPct={fromRows.errPct} p95={fromRows.p95} />;
          return <SummaryCards total={tot.total} errPct={tot.errorShare * 100} p95={tot.p95 !== null ? tot.p95 * 1000 : fromRows.p95} />;
        }}
      </Deferred>

      {/* controls: desktop in one wrapping row; phone (frame 8) service and search in one row, the rest folded.
          No forms (BAC-90): every control writes its own parameter into the URL and keeps the rest. */}
      <div className="hidden flex-wrap items-center gap-2 md:flex">
        <ServiceSelect services={services} service={shown.service} onChange={(v) => update({ service: v })} />
        <RangeSelect range={shown.range} onChange={(v) => update({ range: v })} />
        <HealthBox health={shown.health} onChange={(v) => update({ health: v })} />
        <StatusPicker totals={totals} loadedCounts={loadedCounts} value={statusFilter} onChange={setStatusFilter} />
        <MethodSelect methods={methods} value={method} onChange={setMethod} />
        {chattyControls}
        <RouteSearch q={exactRoute ?? q} exactRoute={exactRoute} onChange={setSearch} onClear={clearSearch} />
      </div>
      <div className="space-y-2 md:hidden">
        <div className="flex min-w-0 items-center gap-2">
          <div className="w-[42%] min-w-0 shrink-0"><ServiceSelect services={services} service={shown.service} onChange={(v) => update({ service: v })} full /></div>
          <RouteSearch q={exactRoute ?? q} exactRoute={exactRoute} onChange={setSearch} onClear={clearSearch} />
        </div>
        <details className="group rounded-lg border border-border bg-surface">
          <summary className="flex h-9 cursor-pointer list-none items-center justify-between px-3 text-[13px] text-muted">
            More filters
            <span className="text-2xs text-faint">{[range !== DEFAULT_RANGE ? `last ${range}` : null, method !== ALL_METHODS ? method : null, statusFilter !== StatusFilter.All ? statusFilter : null, chattyOnly ? "chatty only" : null, sort.key === SortKey.Calls ? "most calls" : null, health === HealthChecks.Shown ? HEALTH_TOGGLE_SHORT : null].filter(Boolean).join(" · ") || `last ${DEFAULT_RANGE}`}</span>
          </summary>
          <div className="flex min-w-0 flex-wrap items-center gap-2 border-t border-border p-2">
            <RangeSelect range={shown.range} onChange={(v) => update({ range: v })} />
            <HealthBox health={shown.health} onChange={(v) => update({ health: v })} />
            <StatusPicker totals={totals} loadedCounts={loadedCounts} value={statusFilter} onChange={setStatusFilter} />
            <MethodSelect methods={methods} value={method} onChange={setMethod} />
            {chattyControls}
          </div>
        </details>
      </div>

      <Card>
        <CardHead
          title="Recent requests"
          sub={`${service === ALL_SERVICES ? "all services" : service}${exactRoute !== null ? ` · ${method !== ALL_METHODS ? method + " " : ""}${exactRoute}` : ""} · last ${range}`}
          right={<Badge tone="neutral">{rows.length}</Badge>}
        />
        <ErrorNote error={feed.error ?? olderError} />
        {rows.length === 0 ? (
          <Empty icon={<Network className="h-5 w-5" />} title="No matching requests">Adjust the filters, widen the service selection or the range.</Empty>
        ) : (
          <>
          {/* phone (frame 8): one card per request; nothing scrolls sideways */}
          <ul className="max-h-[70vh] divide-y divide-border overflow-y-auto md:hidden">
            {rows.map((r) => (
              <li key={`m|${r.traceID}|${r.service}|${r.startMs}`}>
                <Link to={`/requests/${r.traceID}`} className="block px-3.5 py-2.5 hover:bg-surface-2/50">
                  <div className="flex min-w-0 items-start justify-between gap-2.5 font-mono text-[12.5px]">
                    {/* Long or odd paths (scanners: /.env, /debug/vars, 200-byte probes) wrap, at most two lines; the full value on hover. */}
                    <span className="line-clamp-2 min-w-0 [overflow-wrap:anywhere]" title={pathTitle(r.path, r.route)}>
                      {r.method ? <span className="font-semibold text-faint">{r.method} </span> : null}
                      {r.path ?? (r.route || <span className="text-faint">(no route)</span>)}
                    </span>
                    <span className={cn("shrink-0 font-semibold tabular-nums", statusTone(r.status))}>{r.status ?? "—"}</span>
                  </div>
                  {r.path && r.route && r.route !== r.path ? <div className="mt-0.5 truncate font-mono text-2xs text-faint" title={`route ${r.route}`}>{r.route}</div> : null}
                  <div className="mt-[3px] flex min-w-0 items-center justify-between gap-2.5 font-mono text-[11px]">
                    <span className="flex min-w-0 items-center gap-1.5"><span className={cn("min-w-0 truncate text-accent", r.host && "shrink-0")}>{r.service}</span>{r.host ? <span className="min-w-0 truncate text-faint" title={r.host}>{r.host}</span> : null}<MonitorBadge row={r} /><ChattyBadge verdict={chatty.get(rowKey(r))} /></span>
                    <span className={cn("shrink-0 tabular-nums", r.durationMs >= 1000 ? "text-err" : r.durationMs >= 500 ? "text-warn" : "text-faint")}>
                      <Clock ts={r.startMs} seconds /> · {fmtMs(r.durationMs)}
                    </span>
                  </div>
                </Link>
              </li>
            ))}
          </ul>
          <div className="hidden max-h-[64vh] overflow-auto scroll-thin md:block">
            <table className="w-full text-[13px]">
              <thead className="sticky top-0 bg-surface">
                <tr className="border-b border-border text-left text-2xs uppercase tracking-wide text-faint">
                  <th className="px-4 py-2 font-medium"><button onClick={() => toggleSort(SortKey.Time)} className="inline-flex items-center gap-1 uppercase tracking-wide hover:text-fg">Time{sort.key === SortKey.Time ? <span>{sort.dir === SortDir.Asc ? "↑" : "↓"}</span> : null}</button></th>
                  <th className="px-4 py-2 font-medium">Service</th>
                  {hasHosts ? <th className="px-4 py-2 font-medium">Domain</th> : null}
                  <th className="px-4 py-2 font-medium">Method</th>
                  <th className="px-4 py-2 font-medium">Route</th>
                  <th className="px-4 py-2 text-right font-medium"><button onClick={() => toggleSort(SortKey.Status)} className="inline-flex flex-row-reverse items-center gap-1 uppercase tracking-wide hover:text-fg">Status{sort.key === SortKey.Status ? <span>{sort.dir === SortDir.Asc ? "↑" : "↓"}</span> : null}</button></th>
                  <th className="px-4 py-2 text-right font-medium"><button onClick={() => toggleSort(SortKey.Latency)} className="inline-flex flex-row-reverse items-center gap-1 uppercase tracking-wide hover:text-fg">Latency{sort.key === SortKey.Latency ? <span>{sort.dir === SortDir.Asc ? "↑" : "↓"}</span> : null}</button></th>
                  <th className="px-4 py-2"></th>
                </tr>
              </thead>
              <tbody className="font-mono">
                {rows.map((r) => (
                  <tr key={`${r.traceID}|${r.service}|${r.startMs}`} onClick={() => navigate(`/requests/${r.traceID}`)} className="cursor-pointer border-b border-border/40 last:border-0 hover:bg-surface-2/50">
                    <td className="px-4 py-1.5 tabular-nums text-faint"><Clock ts={r.startMs} /></td>
                    <td className="px-4 py-1.5 text-accent">{r.service}</td>
                    {hasHosts ? <td className="max-w-[220px] px-4 py-1.5 text-muted" title={r.host ?? undefined}><span className="block truncate">{r.host ?? ""}</span></td> : null}
                    <td className="whitespace-nowrap px-4 py-1.5 font-semibold text-muted">{r.method || "—"}<MonitorBadge row={r} className="ml-1.5" /><ChattyBadge verdict={chatty.get(rowKey(r))} className="ml-1.5" /></td>
                    <td className="max-w-[360px] px-4 py-1.5 text-fg/90" title={pathTitle(r.path, r.route)}>
                      {r.path ? (
                        <>
                          <span className="block truncate">{r.path}</span>
                          {r.route && r.route !== r.path ? <span className="block truncate text-2xs text-faint">{r.route}</span> : null}
                        </>
                      ) : r.route ? <span className="block truncate">{r.route}</span> : <span className="text-faint">(no route)</span>}
                    </td>
                    <td className={cn("px-4 py-1.5 text-right font-semibold tabular-nums", statusTone(r.status))}>{r.status ?? "—"}</td>
                    <td className={cn("px-4 py-1.5 text-right tabular-nums", r.durationMs >= 1000 ? "text-err" : r.durationMs >= 500 ? "text-warn" : "text-muted")}>{fmtMs(r.durationMs)}</td>
                    <td className="px-4 py-1.5 text-right"><Link to={`/requests/${r.traceID}`} onClick={(e) => e.stopPropagation()} className="font-sans text-2xs font-medium text-brand hover:underline">open</Link></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          </>
        )}
        <div className="flex flex-wrap items-center justify-center gap-3 border-t border-border p-3">
          {next !== null ? (
            <button
              type="button"
              disabled={older.state !== "idle"}
              onClick={() => {
                const p = new URLSearchParams({ service, range, [BEFORE_PARAM]: String(next) });
                if (health === HealthChecks.Shown) p.set(HEALTH_PARAM, "1");
                loadingFor.current = setKey;
                older.load(withEnv(`/requests?${p.toString()}`, env ?? currentEnv));
              }}
              className="inline-flex h-8 items-center rounded-lg border border-border bg-surface px-3 text-[12.5px] font-medium hover:border-border-strong disabled:opacity-60"
            >
              {older.state !== "idle" ? "Loading…" : "Load older requests"}
            </button>
          ) : null}
          <span className="text-2xs text-faint">{next !== null ? `Showing ${all.length} of the last ${range}` : `All ${all.length} requests of the last ${range} are shown`}</span>
        </div>
      </Card>
    </>
  );
}

/** The neutral "chatty" marker (BAC-71). No vertical padding, so the row keeps its height. */
function ChattyBadge({ verdict, className }: { verdict: ChattyVerdict | undefined; className?: string }) {
  if (!verdict?.chatty) return null;
  return (
    <span title={chattySentence(verdict)} className={cn("shrink-0", className)}>
      <Badge tone="neutral" className="py-0 font-sans leading-[1.4]">{CHATTY_BADGE}</Badge>
    </span>
  );
}

/** "Monitor" on a monitor's row (HOP-28): only seen with health checks and monitors shown. */
function MonitorBadge({ row, className }: { row: RequestListRow; className?: string }) {
  if (!row.synthetic) return null;
  return (
    <span title={MONITOR_TITLE} className={cn("shrink-0", className)}>
      <Badge tone="neutral" className="py-0 font-sans leading-[1.4]">{MONITOR_BADGE}</Badge>
    </span>
  );
}

/** "Chatty only" filter and "Most calls" sort, client side over the loaded rows like the others. */
function ChattyControls({ count, only, onOnly, mostCalls, onMostCalls }: { count: number; only: boolean; onOnly: (on: boolean) => void; mostCalls: boolean; onMostCalls: (on: boolean) => void }) {
  const chip = (on: boolean) => cn("inline-flex h-9 items-center gap-1.5 rounded-lg border px-3 text-[13px] transition-colors", on ? "border-border-strong bg-surface-2 text-fg" : "border-border bg-surface text-muted hover:text-fg");
  return (
    <>
      <button type="button" aria-pressed={only} onClick={() => onOnly(!only)} className={chip(only)} title="Requests with many database and cache calls, among the loaded rows">
        Chatty only <span className="text-2xs text-faint">{count.toLocaleString("en-US")}</span>
      </button>
      <button type="button" aria-pressed={mostCalls} onClick={() => onMostCalls(!mostCalls)} className={chip(mostCalls)}>
        Most calls
      </button>
    </>
  );
}

function SummaryCards({ total, errPct, p95 }: { total: number | null; errPct: number | null; p95: number | null }) {
  const val = "mt-1 font-mono text-lg font-semibold tabular-nums sm:text-2xl";
  const tile = "min-w-0 px-3 py-2.5 sm:px-4 sm:py-3.5";
  return (
    <div className="grid grid-cols-3 gap-2 sm:gap-3">
      <Card className={tile}><div className="text-2xs uppercase tracking-wide text-faint">Requests</div><div className={val}>{total === null ? <Skeleton className="h-7 w-16" /> : total.toLocaleString("en-US")}</div></Card>
      <Card className={tile}><div className="truncate text-2xs uppercase tracking-wide text-faint">Error rate</div><div className={cn(val, errPct === null ? "" : errPct >= 5 ? "text-err" : errPct >= 1 ? "text-warn" : "text-ok")}>{errPct === null ? <Skeleton className="h-7 w-14" /> : fmtPct(errPct)}</div></Card>
      <Card className={tile}><div className="truncate text-2xs uppercase tracking-wide text-faint">p95 latency</div><div className={cn(val, p95 !== null && (p95 >= 1000 ? "text-err" : p95 >= 500 ? "text-warn" : ""))}>{p95 === null ? <Skeleton className="h-7 w-16" /> : fmtMs(p95)}</div></Card>
    </div>
  );
}

function StatusSeg({ counts, value, onChange }: { counts: Record<string, number>; value: StatusFilter; onChange: (f: StatusFilter) => void }) {
  return (
    <div className="inline-flex max-w-full flex-wrap rounded-lg border border-border bg-surface p-0.5 text-2xs">
      {FILTERS.map((f) => (
        <button key={f} type="button" onClick={() => onChange(f)} aria-pressed={value === f} className={cn("rounded-md px-2.5 py-1.5 font-medium transition-colors", value === f ? "bg-surface-2 text-fg" : "text-muted hover:text-fg")}>
          {f} <span className="text-faint">{(counts[f] ?? 0).toLocaleString("en-US")}</span>
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- filter controls (shared by both layouts)

function ServiceSelect({ services, service, onChange, full = false }: { services: string[]; service: string; onChange: (v: string) => void; full?: boolean }) {
  return (
    <select value={service} onChange={(e) => onChange(e.target.value)} className={cn(SELECT, full && "w-full sm:w-full")} aria-label="Service">
      <option value={ALL_SERVICES}>All services</option>
      {services.map((s) => <option key={s} value={s}>{s}</option>)}
    </select>
  );
}

function RangeSelect({ range, onChange }: { range: RequestRange; onChange: (v: RequestRange) => void }) {
  return (
    <select value={range} onChange={(e) => { const v = e.target.value; if (isRequestRange(v)) onChange(v); }} className={cn(SELECT, "w-auto")} aria-label="Range">
      {Object.keys(REQUEST_RANGES).map((r) => <option key={r} value={r}>last {r}</option>)}
    </select>
  );
}

function HealthBox({ health, onChange }: { health: HealthChecks; onChange: (v: HealthChecks) => void }) {
  return (
    <label className="inline-flex h-9 items-center gap-2 rounded-lg border border-border bg-surface px-3 text-[13px] text-muted">
      <input type="checkbox" checked={health === HealthChecks.Shown} onChange={(e) => onChange(e.target.checked ? HealthChecks.Shown : HealthChecks.Hidden)} className="accent-brand" />
      {HEALTH_TOGGLE_LABEL}
    </label>
  );
}

function MethodSelect({ methods, value, onChange }: { methods: string[]; value: string; onChange: (m: string) => void }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} className={cn(SELECT, "w-auto")} aria-label="Method">
      {methods.map((m) => <option key={m} value={m}>{m === "all" ? "all methods" : m}</option>)}
    </select>
  );
}

/** The search box: shows what is typed at once and writes the URL after a short pause. A value
 *  arriving from the URL (back, reload, a link) replaces the box unless it is what was just typed. */
function RouteSearch({ q, exactRoute, onChange, onClear }: { q: string; exactRoute: string | null; onChange: (v: string) => void; onClear: () => void }) {
  const [text, setText] = useState(q);
  const written = useRef(q);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (q === written.current) return;
    written.current = q;
    setText(q);
  }, [q]);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const type = (v: string): void => {
    setText(v);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      written.current = v;
      onChange(v);
    }, SEARCH_DEBOUNCE_MS);
  };
  return (
    <div className="relative min-w-0 flex-1 md:min-w-[200px]">
      <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-faint" />
      <input
        value={text}
        onChange={(e) => type(e.target.value)}
        placeholder="Filter by path, route, domain or service"
        aria-label="Filter by path, route, domain or service"
        className="h-9 w-full rounded-lg border border-border bg-surface pl-9 pr-9 text-[13px] outline-none placeholder:text-faint focus:border-brand/40"
      />
      {exactRoute !== null || text ? (
        <button
          type="button"
          onClick={() => {
            if (timer.current) clearTimeout(timer.current);
            written.current = "";
            setText("");
            onClear();
          }}
          aria-label={exactRoute !== null ? "Clear the route filter" : "Clear the search"}
          className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-faint hover:text-fg"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      ) : null}
    </div>
  );
}

function StatusPicker({
  totals,
  loadedCounts,
  value,
  onChange,
}: {
  totals: Promise<{ data: InboundTotals | null; error: string | null }>;
  loadedCounts: Record<string, number>;
  value: StatusFilter;
  onChange: (f: StatusFilter) => void;
}) {
  return (
    <Deferred resolve={totals} fallback={<StatusSeg counts={loadedCounts} value={value} onChange={onChange} />}>
      {(t) => {
        const tot = t.data;
        const counts =
          tot && tot.total > 0
            ? { all: tot.total, ...Object.fromEntries(FILTERS.slice(1).map((f) => [f, tot.byClass[f as keyof InboundTotals["byClass"]]])) }
            : loadedCounts;
        return <StatusSeg counts={counts} value={value} onChange={onChange} />;
      }}
    </Deferred>
  );
}
