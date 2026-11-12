import type { LoaderFunctionArgs } from "@remix-run/node";
import { defer, json } from "@remix-run/node";
import { Form, Link, useFetcher, useLoaderData, useNavigate, useSearchParams, useSubmit } from "@remix-run/react";
import { useEffect, useMemo, useState } from "react";
import { Network, Search, X } from "lucide-react";
import { Badge, Card, CardHead, Empty, ErrorNote, PageTitle, Skeleton } from "~/components/ui";
import { Deferred, RowsSkeleton } from "~/components/defer";
import * as jaeger from "~/lib/jaeger.server";
import { safe } from "~/lib/config.server";
import { requireOrg } from "~/lib/auth/context.server";
import { tenantOf, type Tenant } from "~/lib/tenant.server";
import { cached } from "~/lib/cache.server";
import { inboundHttpTotals, inboundServices, type InboundTotals } from "~/lib/hops/metrics.server";
import { hopRequestPage, mergeRows, RowSource, type HopPage, type RequestListRow } from "~/lib/hops/requests.server";
import { cn, fmtClock, fmtMs, fmtPct } from "~/lib/utils";

const RANGES: Record<string, number> = { "1h": 1, "6h": 6, "24h": 24 };

/** Span-derived rows, as before: one Jaeger query per service, cached against the 10 s poll. */
function spanRows(t: Tenant, list: string[], chosen: string, rangeKey: string, hrs: number) {
  return cached(`req:rows:${t.orgId}:${chosen}:${rangeKey}`, 8000, async () => {
    let rows: jaeger.RequestRow[] = [];
    let error: string | null = null;
    if (chosen === "all" && list.length) {
      const batches = await Promise.all(
        list.slice(0, 12).map((s) => safe(() => jaeger.recentRequests({ service: s, limit: 40, lookbackHours: hrs }, t), [] as jaeger.RequestRow[]))
      );
      rows = batches.flatMap((b) => b.data).sort((a, b) => b.startMs - a.startMs).slice(0, 200);
      error = batches.find((b) => b.error)?.error ?? null;
    } else if (chosen && list.includes(chosen)) {
      const r = await safe(() => jaeger.recentRequests({ service: chosen, limit: 120, lookbackHours: hrs }, t), [] as jaeger.RequestRow[]);
      rows = r.data;
      error = r.error;
    }
    return { rows, error };
  });
}

interface FeedData {
  rows: RequestListRow[];
  next: number | null;
  error: string | null;
}

export async function loader({ request }: LoaderFunctionArgs) {
  const ctx = await requireOrg(request);
  const t = tenantOf(ctx.org.id);
  const url = new URL(request.url);
  const requested = url.searchParams.get("service") || "all";
  const rangeKey = RANGES[url.searchParams.get("range") ?? ""] ? (url.searchParams.get("range") as string) : "1h";
  const hrs = RANGES[rangeKey];
  const sinceMs = Date.now() - hrs * 3600_000;
  const beforeRaw = Number(url.searchParams.get("before"));

  // cache the Jaeger fan-out so the 10s live-poll doesn't re-fire up to 12 trace queries every tick (PERF-3)
  const [spanServices, hopServices] = await Promise.all([
    cached(`req:svcs:${t.orgId}`, 30000, () => safe(() => jaeger.services(t), [] as string[])),
    safe(() => inboundServices(t), [] as string[]),
  ]);
  const list = [...new Set([...spanServices.data, ...hopServices.data])].sort();
  const chosen = requested === "all" ? "all" : list.includes(requested) ? requested : "all";
  const hopService = chosen === "all" ? null : chosen;

  // "Load older requests": the next 100 hop rows before the cursor (design 13).
  if (Number.isFinite(beforeRaw) && beforeRaw > 0) {
    const page = await safe(() => hopRequestPage(t, { service: hopService, sinceMs, before: beforeRaw }), { rows: [], next: null } as HopPage);
    return json({ kind: "older" as const, page: page.data, error: page.error });
  }

  const feed: Promise<FeedData> = Promise.all([
    spanRows(t, spanServices.data, chosen, rangeKey, hrs),
    safe(() => hopRequestPage(t, { service: hopService, sinceMs, before: Date.now() }), { rows: [], next: null } as HopPage),
  ]).then(([spans, hops]) => ({
    rows: mergeRows(hops.data.rows, spans.rows.map((r) => ({ ...r, source: RowSource.Span }))),
    next: hops.data.next,
    error: hops.error ?? spans.error,
  }));
  const totals: Promise<{ data: InboundTotals | null; error: string | null }> = safe(() => inboundHttpTotals(rangeKey, hopService, t), null);

  return defer({
    kind: "page" as const,
    services: list,
    hopServices: hopServices.data,
    service: chosen,
    range: rangeKey,
    feed,
    totals,
  });
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

const FILTERS = ["all", "2xx", "3xx", "4xx", "5xx"] as const;
type StatusFilter = (typeof FILTERS)[number];
type SortKey = "time" | "status" | "latency";

const SELECT = "h-9 w-full max-w-full sm:w-auto rounded-lg border border-border bg-surface px-3 text-[13px] outline-none focus:border-brand/40";

export default function Requests() {
  const d = useLoaderData<typeof loader>();
  if (d.kind !== "page") return null;
  const hasServices = d.services.length > 0;
  return (
    <div className="space-y-4 animate-fade-in">
      <PageTitle title="Requests" sub="A live feed of individual requests across your services: method, route, status and latency." />
      {!hasServices ? (
        <Card>
          <div className="flex flex-col items-center px-6 py-14 text-center">
            <span className="grid h-11 w-11 place-items-center rounded-xl bg-surface-2 text-faint"><Network className="h-5 w-5" /></span>
            <p className="mt-4 text-sm font-medium">No services report requests yet</p>
            <p className="mt-1 max-w-[56ch] text-[13px] text-muted">Requests appear here once a service runs Correlator with hop records on, or emits OpenTelemetry HTTP spans to backwork.</p>
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
              <Card><CardHead title="Recent requests" sub={`${d.service === "all" ? "all services" : d.service} · last ${d.range}`} /><RowsSkeleton rows={8} /></Card>
            </>
          }
        >
          {(feed) => <Feed key={`${d.service}|${d.range}`} feed={feed} totals={d.totals} services={d.services} hopServices={d.hopServices} service={d.service} range={d.range} />}
        </Deferred>
      )}
    </div>
  );
}

function Feed({
  feed,
  totals,
  services,
  hopServices,
  service,
  range,
}: {
  feed: FeedData;
  totals: Promise<{ data: InboundTotals | null; error: string | null }>;
  services: string[];
  hopServices: string[];
  service: string;
  range: string;
}) {
  const submit = useSubmit();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const routeParam = params.get("route");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [method, setMethod] = useState(params.get("method") || "all");
  const [q, setQ] = useState(routeParam ?? "");
  const [exactRoute, setExactRoute] = useState<string | null>(routeParam);
  const [sort, setSort] = useState<{ key: SortKey | null; dir: "asc" | "desc" }>({ key: null, dir: "desc" });
  const toggleSort = (key: SortKey) => setSort((s) => (s.key === key ? { key, dir: s.dir === "asc" ? "desc" : "asc" } : { key, dir: "desc" }));

  // Older pages are appended in place; the live poll refreshes only the newest page.
  const older = useFetcher<typeof loader>();
  const [olderRows, setOlderRows] = useState<RequestListRow[]>([]);
  const [next, setNext] = useState<number | null>(feed.next);
  const [olderError, setOlderError] = useState<string | null>(null);
  useEffect(() => {
    const data = older.data;
    if (older.state !== "idle" || !data || data.kind !== "older") return;
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
      const k = `${r.traceID}|${r.service}|${r.startMs}`;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(r);
    }
    return out;
  }, [feed.rows, olderRows]);

  const methods = useMemo(() => {
    const set = new Set(all.map((r) => r.method).filter(Boolean));
    if (method !== "all") set.add(method);
    return ["all", ...Array.from(set).sort()];
  }, [all, method]);

  const rows = useMemo(() => {
    let r = all;
    if (statusFilter !== "all") r = r.filter((x) => cls(x.status) === statusFilter);
    if (method !== "all") r = r.filter((x) => x.method === method);
    if (exactRoute !== null) r = r.filter((x) => x.route === exactRoute);
    else if (q.trim()) {
      const t = q.trim().toLowerCase();
      r = r.filter((x) => x.route.toLowerCase().includes(t) || x.service.toLowerCase().includes(t));
    }
    if (sort.key) {
      const m = sort.dir === "asc" ? 1 : -1;
      const val = (x: RequestListRow) => (sort.key === "time" ? x.startMs : sort.key === "latency" ? x.durationMs : x.status ?? 0);
      r = [...r].sort((a, b) => (val(a) - val(b)) * m);
    }
    return r;
  }, [all, statusFilter, method, q, exactRoute, sort]);

  const filtered = statusFilter !== "all" || method !== "all" || exactRoute !== null || q.trim() !== "";
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

  const hopSet = useMemo(() => new Set(hopServices), [hopServices]);
  const spanOnly = useMemo(() => all.filter((r) => r.source === RowSource.Span && !hopSet.has(r.service)), [all, hopSet]);

  return (
    <>
      {/* summary: range totals from hop metrics (plus span-only rows), or the filtered rows when a filter is on */}
      <Deferred resolve={totals} fallback={<SummaryCards total={null} errPct={null} p95={null} />}>
        {(t) => {
          const tot = t.data;
          if (filtered || !tot || tot.total === 0) return <SummaryCards total={fromRows.total} errPct={fromRows.errPct} p95={fromRows.p95} />;
          const spanErr = spanOnly.filter((r) => r.error || (r.status ?? 0) >= 500).length;
          const total = tot.total + spanOnly.length;
          const errPct = total ? ((tot.errorShare * tot.total + spanErr) / total) * 100 : 0;
          return <SummaryCards total={total} errPct={errPct} p95={tot.p95 !== null ? tot.p95 * 1000 : fromRows.p95} />;
        }}
      </Deferred>

      {/* controls */}
      <div className="flex flex-wrap items-center gap-2">
        <Form method="get" className="flex flex-wrap items-center gap-2">
          <select name="service" defaultValue={service} onChange={(e) => submit(e.currentTarget.form)} className={SELECT} aria-label="Service">
            <option value="all">All services</option>
            {services.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
          <select name="range" defaultValue={range} onChange={(e) => submit(e.currentTarget.form)} className={SELECT} aria-label="Range">
            {Object.keys(RANGES).map((r) => <option key={r} value={r}>last {r}</option>)}
          </select>
        </Form>
        <Deferred resolve={totals} fallback={<StatusSeg counts={loadedCounts} value={statusFilter} onChange={setStatusFilter} />}>
          {(t) => {
            const tot = t.data;
            const counts =
              tot && tot.total > 0
                ? {
                    all: tot.total + spanOnly.length,
                    ...Object.fromEntries(FILTERS.slice(1).map((f) => [f, tot.byClass[f as keyof InboundTotals["byClass"]] + spanOnly.filter((r) => cls(r.status) === f).length])),
                  }
                : loadedCounts;
            return <StatusSeg counts={counts} value={statusFilter} onChange={setStatusFilter} />;
          }}
        </Deferred>
        <select value={method} onChange={(e) => setMethod(e.target.value)} className={SELECT} aria-label="Method">
          {methods.map((m) => <option key={m} value={m}>{m === "all" ? "all methods" : m}</option>)}
        </select>
        <div className="relative min-w-[200px] flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-faint" />
          <input
            value={q}
            onChange={(e) => { setQ(e.target.value); setExactRoute(null); }}
            placeholder="Filter by route or service"
            aria-label="Filter by route or service"
            className="h-9 w-full rounded-lg border border-border bg-surface pl-9 pr-9 text-[13px] outline-none placeholder:text-faint focus:border-brand/40"
          />
          {exactRoute !== null ? (
            <button type="button" onClick={() => { setExactRoute(null); setQ(""); }} aria-label="Clear the route filter" className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-faint hover:text-fg">
              <X className="h-3.5 w-3.5" />
            </button>
          ) : null}
        </div>
      </div>

      <Card>
        <CardHead
          title="Recent requests"
          sub={`${service === "all" ? "all services" : service}${exactRoute !== null ? ` · ${method !== "all" ? method + " " : ""}${exactRoute}` : ""} · last ${range}`}
          right={<Badge tone="neutral">{rows.length}</Badge>}
        />
        <ErrorNote error={feed.error ?? olderError} />
        {rows.length === 0 ? (
          <Empty icon={<Network className="h-5 w-5" />} title="No matching requests">Adjust the filters, widen the service selection or the range.</Empty>
        ) : (
          <div className="max-h-[64vh] overflow-auto scroll-thin">
            <table className="w-full text-[13px]">
              <thead className="sticky top-0 bg-surface">
                <tr className="border-b border-border text-left text-2xs uppercase tracking-wide text-faint">
                  <th className="px-4 py-2 font-medium"><button onClick={() => toggleSort("time")} className="inline-flex items-center gap-1 uppercase tracking-wide hover:text-fg">Time{sort.key === "time" ? <span>{sort.dir === "asc" ? "↑" : "↓"}</span> : null}</button></th>
                  <th className="px-4 py-2 font-medium">Service</th>
                  <th className="px-4 py-2 font-medium">Method</th>
                  <th className="px-4 py-2 font-medium">Route</th>
                  <th className="px-4 py-2 text-right font-medium"><button onClick={() => toggleSort("status")} className="inline-flex flex-row-reverse items-center gap-1 uppercase tracking-wide hover:text-fg">Status{sort.key === "status" ? <span>{sort.dir === "asc" ? "↑" : "↓"}</span> : null}</button></th>
                  <th className="px-4 py-2 text-right font-medium"><button onClick={() => toggleSort("latency")} className="inline-flex flex-row-reverse items-center gap-1 uppercase tracking-wide hover:text-fg">Latency{sort.key === "latency" ? <span>{sort.dir === "asc" ? "↑" : "↓"}</span> : null}</button></th>
                  <th className="px-4 py-2"></th>
                </tr>
              </thead>
              <tbody className="font-mono">
                {rows.map((r) => (
                  <tr key={`${r.traceID}|${r.service}|${r.startMs}`} onClick={() => navigate(`/traces/${r.traceID}`)} className="cursor-pointer border-b border-border/40 last:border-0 hover:bg-surface-2/50">
                    <td className="px-4 py-1.5 tabular-nums text-faint">{fmtClock(r.startMs)}</td>
                    <td className="px-4 py-1.5 text-accent">{r.service}</td>
                    <td className="px-4 py-1.5 font-semibold text-muted">{r.method || "—"}</td>
                    <td className="max-w-[360px] truncate px-4 py-1.5 text-fg/90">{r.route || <span className="text-faint">(no route)</span>}</td>
                    <td className={cn("px-4 py-1.5 text-right font-semibold tabular-nums", statusTone(r.status))}>{r.status ?? "—"}</td>
                    <td className={cn("px-4 py-1.5 text-right tabular-nums", r.durationMs >= 1000 ? "text-err" : r.durationMs >= 500 ? "text-warn" : "text-muted")}>{fmtMs(r.durationMs)}</td>
                    <td className="px-4 py-1.5 text-right"><Link to={`/traces/${r.traceID}`} onClick={(e) => e.stopPropagation()} className="font-sans text-2xs font-medium text-brand hover:underline">open</Link></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="flex flex-wrap items-center justify-center gap-3 border-t border-border p-3">
          {next !== null ? (
            <button
              type="button"
              disabled={older.state !== "idle"}
              onClick={() => {
                const p = new URLSearchParams({ service, range, before: String(next) });
                older.load(`/requests?${p.toString()}`);
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

function SummaryCards({ total, errPct, p95 }: { total: number | null; errPct: number | null; p95: number | null }) {
  const val = "mt-1 font-mono text-2xl font-semibold tabular-nums";
  return (
    <div className="grid grid-cols-3 gap-3">
      <Card className="px-4 py-3.5"><div className="text-2xs uppercase tracking-wide text-faint">Requests</div><div className={val}>{total === null ? <Skeleton className="h-7 w-16" /> : total.toLocaleString("en-US")}</div></Card>
      <Card className="px-4 py-3.5"><div className="text-2xs uppercase tracking-wide text-faint">Error rate</div><div className={cn(val, errPct === null ? "" : errPct >= 5 ? "text-err" : errPct >= 1 ? "text-warn" : "text-ok")}>{errPct === null ? <Skeleton className="h-7 w-14" /> : fmtPct(errPct)}</div></Card>
      <Card className="px-4 py-3.5"><div className="text-2xs uppercase tracking-wide text-faint">p95 latency</div><div className={cn(val, p95 !== null && (p95 >= 1000 ? "text-err" : p95 >= 500 ? "text-warn" : ""))}>{p95 === null ? <Skeleton className="h-7 w-16" /> : fmtMs(p95)}</div></Card>
    </div>
  );
}

function StatusSeg({ counts, value, onChange }: { counts: Record<string, number>; value: StatusFilter; onChange: (f: StatusFilter) => void }) {
  return (
    <div className="inline-flex rounded-lg border border-border bg-surface p-0.5 text-2xs">
      {FILTERS.map((f) => (
        <button key={f} type="button" onClick={() => onChange(f)} aria-pressed={value === f} className={cn("rounded-md px-2.5 py-1.5 font-medium transition-colors", value === f ? "bg-surface-2 text-fg" : "text-muted hover:text-fg")}>
          {f} <span className="text-faint">{(counts[f] ?? 0).toLocaleString("en-US")}</span>
        </button>
      ))}
    </div>
  );
}
