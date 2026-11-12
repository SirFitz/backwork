import type { LoaderFunctionArgs } from "@remix-run/node";
import { defer, json } from "@remix-run/node";
import { Form, Link, useFetcher, useLoaderData, useNavigate, useSearchParams, useSubmit } from "@remix-run/react";
import { useEffect, useMemo, useState } from "react";
import { Network, Search, X } from "lucide-react";
import { Badge, Card, CardHead, Empty, ErrorNote, PageTitle, Skeleton } from "~/components/ui";
import { Deferred, RowsSkeleton } from "~/components/defer";
import { safe } from "~/lib/config.server";
import { requireOrg } from "~/lib/auth/context.server";
import { tenantOf } from "~/lib/tenant.server";
import { inboundHttpTotals, inboundServices, type InboundTotals } from "~/lib/hops/metrics.server";
import { hopRequestPage, type HopPage, type RequestListRow } from "~/lib/hops/requests.server";
import { HEALTH_PARAM, HealthChecks, healthChecksFrom } from "~/lib/hops/health";
import { cn, fmtMs, fmtPct } from "~/lib/utils";
import { Clock } from "~/components/time";

const RANGES: Record<string, number> = { "1h": 1, "6h": 6, "24h": 24 };

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
  const health = healthChecksFrom(url.searchParams.get(HEALTH_PARAM));

  const services = await safe(() => inboundServices(t), [] as string[]);
  const list = services.data;
  const chosen = requested === "all" ? "all" : list.includes(requested) ? requested : "all";
  const hopService = chosen === "all" ? null : chosen;

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
    services: list,
    service: chosen,
    range: rangeKey,
    health,
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
              <Card><CardHead title="Recent requests" sub={`${d.service === "all" ? "all services" : d.service} · last ${d.range}`} /><RowsSkeleton rows={8} /></Card>
            </>
          }
        >
          {(feed) => <Feed key={`${d.service}|${d.range}|${d.health}`} feed={feed} totals={d.totals} services={d.services} service={d.service} range={d.range} health={d.health} />}
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
}: {
  feed: FeedData;
  totals: Promise<{ data: InboundTotals | null; error: string | null }>;
  services: string[];
  service: string;
  range: string;
  health: HealthChecks;
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
      r = r.filter((x) => x.route.toLowerCase().includes(t) || (x.path ?? "").toLowerCase().includes(t) || x.service.toLowerCase().includes(t));
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

      {/* controls: desktop in one wrapping row; phone (frame 8) service and search in one row, the rest folded */}
      <div className="hidden flex-wrap items-center gap-2 md:flex">
        <Form method="get" className="flex flex-wrap items-center gap-2">
          <ServiceSelect services={services} service={service} />
          <RangeSelect range={range} />
          <HealthBox health={health} />
        </Form>
        <StatusPicker totals={totals} loadedCounts={loadedCounts} value={statusFilter} onChange={setStatusFilter} />
        <MethodSelect methods={methods} value={method} onChange={setMethod} />
        <RouteSearch q={q} exactRoute={exactRoute} onChange={(v) => { setQ(v); setExactRoute(null); }} onClear={() => { setExactRoute(null); setQ(""); }} />
      </div>
      <div className="space-y-2 md:hidden">
        <Form method="get" className="flex min-w-0 items-center gap-2">
          <input type="hidden" name="range" value={range} />
          {health === HealthChecks.Shown ? <input type="hidden" name={HEALTH_PARAM} value="1" /> : null}
          <div className="w-[42%] min-w-0 shrink-0"><ServiceSelect services={services} service={service} full /></div>
          <RouteSearch q={q} exactRoute={exactRoute} onChange={(v) => { setQ(v); setExactRoute(null); }} onClear={() => { setExactRoute(null); setQ(""); }} />
        </Form>
        <details className="group rounded-lg border border-border bg-surface">
          <summary className="flex h-9 cursor-pointer list-none items-center justify-between px-3 text-[13px] text-muted">
            More filters
            <span className="text-2xs text-faint">{[range !== "1h" ? `last ${range}` : null, method !== "all" ? method : null, statusFilter !== "all" ? statusFilter : null, health === HealthChecks.Shown ? "health checks" : null].filter(Boolean).join(" · ") || "last 1h"}</span>
          </summary>
          <div className="flex min-w-0 flex-wrap items-center gap-2 border-t border-border p-2">
            <Form method="get" className="flex min-w-0 flex-wrap items-center gap-2">
              <input type="hidden" name="service" value={service} />
              <RangeSelect range={range} />
              <HealthBox health={health} />
            </Form>
            <StatusPicker totals={totals} loadedCounts={loadedCounts} value={statusFilter} onChange={setStatusFilter} />
            <MethodSelect methods={methods} value={method} onChange={setMethod} />
          </div>
        </details>
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
          <>
          {/* phone (frame 8): one card per request; nothing scrolls sideways */}
          <ul className="max-h-[70vh] divide-y divide-border overflow-y-auto md:hidden">
            {rows.map((r) => (
              <li key={`m|${r.traceID}|${r.service}|${r.startMs}`}>
                <Link to={`/requests/${r.traceID}`} className="block px-3.5 py-2.5 hover:bg-surface-2/50">
                  <div className="flex min-w-0 items-start justify-between gap-2.5 font-mono text-[12.5px]">
                    <span className="min-w-0 [overflow-wrap:anywhere]">
                      {r.method ? <span className="font-semibold text-faint">{r.method} </span> : null}
                      {r.path ?? (r.route || <span className="text-faint">(no route)</span>)}
                    </span>
                    <span className={cn("shrink-0 font-semibold tabular-nums", statusTone(r.status))}>{r.status ?? "—"}</span>
                  </div>
                  {r.path && r.route && r.route !== r.path ? <div className="mt-0.5 font-mono text-2xs text-faint [overflow-wrap:anywhere]">{r.route}</div> : null}
                  <div className="mt-[3px] flex min-w-0 items-center justify-between gap-2.5 font-mono text-[11px]">
                    <span className="min-w-0 truncate text-accent">{r.service}</span>
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
                  <tr key={`${r.traceID}|${r.service}|${r.startMs}`} onClick={() => navigate(`/requests/${r.traceID}`)} className="cursor-pointer border-b border-border/40 last:border-0 hover:bg-surface-2/50">
                    <td className="px-4 py-1.5 tabular-nums text-faint"><Clock ts={r.startMs} /></td>
                    <td className="px-4 py-1.5 text-accent">{r.service}</td>
                    <td className="px-4 py-1.5 font-semibold text-muted">{r.method || "—"}</td>
                    <td className="max-w-[360px] px-4 py-1.5 text-fg/90" title={r.path && r.route ? `route ${r.route}` : undefined}>
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
                const p = new URLSearchParams({ service, range, before: String(next) });
                if (health === HealthChecks.Shown) p.set(HEALTH_PARAM, "1");
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

function ServiceSelect({ services, service, full = false }: { services: string[]; service: string; full?: boolean }) {
  const submit = useSubmit();
  return (
    <select name="service" defaultValue={service} onChange={(e) => submit(e.currentTarget.form)} className={cn(SELECT, full && "w-full sm:w-full")} aria-label="Service">
      <option value="all">All services</option>
      {services.map((s) => <option key={s} value={s}>{s}</option>)}
    </select>
  );
}

function RangeSelect({ range }: { range: string }) {
  const submit = useSubmit();
  return (
    <select name="range" defaultValue={range} onChange={(e) => submit(e.currentTarget.form)} className={cn(SELECT, "w-auto")} aria-label="Range">
      {Object.keys(RANGES).map((r) => <option key={r} value={r}>last {r}</option>)}
    </select>
  );
}

function HealthBox({ health }: { health: HealthChecks }) {
  const submit = useSubmit();
  return (
    <label className="inline-flex h-9 items-center gap-2 rounded-lg border border-border bg-surface px-3 text-[13px] text-muted">
      <input type="checkbox" name={HEALTH_PARAM} value="1" defaultChecked={health === HealthChecks.Shown} onChange={(e) => submit(e.currentTarget.form)} className="accent-brand" />
      Show health checks
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

function RouteSearch({ q, exactRoute, onChange, onClear }: { q: string; exactRoute: string | null; onChange: (v: string) => void; onClear: () => void }) {
  return (
    <div className="relative min-w-0 flex-1 md:min-w-[200px]">
      <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-faint" />
      <input
        value={q}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Filter by path, route or service"
        aria-label="Filter by path, route or service"
        className="h-9 w-full rounded-lg border border-border bg-surface pl-9 pr-9 text-[13px] outline-none placeholder:text-faint focus:border-brand/40"
      />
      {exactRoute !== null ? (
        <button type="button" onClick={onClear} aria-label="Clear the route filter" className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-faint hover:text-fg">
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
