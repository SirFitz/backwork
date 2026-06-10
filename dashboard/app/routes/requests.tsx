import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { Form, Link, useLoaderData, useSubmit } from "@remix-run/react";
import { useMemo, useState } from "react";
import { Network, Search } from "lucide-react";
import { Badge, Card, CardHead, Empty, ErrorNote, PageTitle } from "~/components/ui";
import * as jaeger from "~/lib/jaeger.server";
import { safe } from "~/lib/config.server";
import { requireOrg } from "~/lib/auth/context.server";
import { tenantOf } from "~/lib/tenant.server";
import { cn, fmtClock, fmtMs, fmtPct } from "~/lib/utils";

export async function loader({ request }: LoaderFunctionArgs) {
  const ctx = await requireOrg(request);
  const t = tenantOf(ctx.org.id);
  const requested = new URL(request.url).searchParams.get("service") || "all";
  const services = await safe(() => jaeger.services(t), [] as string[]);
  const list = services.data;
  const chosen = requested === "all" ? "all" : list.includes(requested) ? requested : list[0] || "";

  let rows: jaeger.RequestRow[] = [];
  let error: string | null = null;
  if (chosen === "all" && list.length) {
    const batches = await Promise.all(
      list.slice(0, 12).map((s) => safe(() => jaeger.recentRequests({ service: s, limit: 40, lookbackHours: 1 }, t), [] as jaeger.RequestRow[]))
    );
    rows = batches.flatMap((b) => b.data).sort((a, b) => b.startMs - a.startMs).slice(0, 200);
    error = batches.find((b) => b.error)?.error ?? null;
  } else if (chosen) {
    const r = await safe(() => jaeger.recentRequests({ service: chosen, limit: 120, lookbackHours: 1 }, t), [] as jaeger.RequestRow[]);
    rows = r.data;
    error = r.error;
  }
  const capped = chosen === "all" ? rows.length >= 200 : rows.length >= 120;
  return json({ services: list, rows, error, service: chosen, capped });
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

export default function Requests() {
  const d = useLoaderData<typeof loader>();
  const submit = useSubmit();
  const [statusFilter, setStatusFilter] = useState<(typeof FILTERS)[number]>("all");
  const [method, setMethod] = useState("all");
  const [q, setQ] = useState("");

  const methods = useMemo(() => ["all", ...Array.from(new Set(d.rows.map((r) => r.method).filter(Boolean))).sort()], [d.rows]);

  const rows = useMemo(() => {
    let r = d.rows;
    if (statusFilter !== "all") r = r.filter((x) => cls(x.status) === statusFilter);
    if (method !== "all") r = r.filter((x) => x.method === method);
    if (q.trim()) {
      const t = q.trim().toLowerCase();
      r = r.filter((x) => x.route.toLowerCase().includes(t) || x.service.toLowerCase().includes(t));
    }
    return r;
  }, [d.rows, statusFilter, method, q]);

  const summary = useMemo(() => {
    const total = rows.length;
    const errs = rows.filter((r) => r.error || (r.status ?? 0) >= 500).length;
    return { total, errPct: total ? (errs / total) * 100 : 0, p95: pctl(rows.map((r) => r.durationMs), 95) };
  }, [rows]);

  const counts = useMemo(() => {
    const c: Record<string, number> = { all: d.rows.length };
    for (const f of FILTERS.slice(1)) c[f] = d.rows.filter((r) => cls(r.status) === f).length;
    return c;
  }, [d.rows]);

  return (
    <div className="space-y-4 animate-fade-in">
      <PageTitle title="Requests" sub="A live feed of individual HTTP requests across instrumented services — method, route, status and latency, pulled from traces." />

      {d.services.length === 0 ? (
        <Card>
          <div className="flex flex-col items-center px-6 py-14 text-center">
            <span className="grid h-11 w-11 place-items-center rounded-xl bg-surface-2 text-faint"><Network className="h-5 w-5" /></span>
            <p className="mt-4 text-sm font-medium">No instrumented services yet</p>
            <p className="mt-1 max-w-[52ch] text-[13px] text-muted">Requests appear here once an app emits OpenTelemetry HTTP spans. Point an OTLP exporter at backwork to populate this.</p>
          </div>
        </Card>
      ) : (
        <>
          {/* summary */}
          <div className="grid grid-cols-3 gap-3">
            <Card className="px-4 py-3.5"><div className="text-2xs uppercase tracking-wide text-faint">Requests</div><div className="mt-1 font-mono text-2xl font-semibold tabular-nums">{summary.total}</div></Card>
            <Card className="px-4 py-3.5"><div className="text-2xs uppercase tracking-wide text-faint">Error rate</div><div className={cn("mt-1 font-mono text-2xl font-semibold tabular-nums", summary.errPct >= 5 ? "text-err" : summary.errPct >= 1 ? "text-warn" : "text-ok")}>{fmtPct(summary.errPct)}</div></Card>
            <Card className="px-4 py-3.5"><div className="text-2xs uppercase tracking-wide text-faint">p95 latency</div><div className={cn("mt-1 font-mono text-2xl font-semibold tabular-nums", summary.p95 >= 1000 ? "text-err" : summary.p95 >= 500 ? "text-warn" : "")}>{fmtMs(summary.p95)}</div></Card>
          </div>

          {/* controls */}
          <div className="flex flex-wrap items-center gap-2">
            <Form method="get">
              <select name="service" defaultValue={d.service} onChange={(e) => submit(e.currentTarget.form)} className="h-9 rounded-lg border border-border bg-surface px-3 text-[13px] outline-none focus:border-brand/40">
                <option value="all">All instrumented</option>
                {d.services.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </Form>
            <div className="inline-flex rounded-lg border border-border bg-surface p-0.5 text-2xs">
              {FILTERS.map((f) => (
                <button key={f} onClick={() => setStatusFilter(f)} className={cn("rounded-md px-2.5 py-1.5 font-medium transition-colors", statusFilter === f ? "bg-surface-2 text-fg" : "text-muted hover:text-fg")}>
                  {f} <span className="text-faint">{counts[f] ?? 0}</span>
                </button>
              ))}
            </div>
            <select value={method} onChange={(e) => setMethod(e.target.value)} className="h-9 rounded-lg border border-border bg-surface px-3 text-[13px] outline-none focus:border-brand/40">
              {methods.map((m) => <option key={m} value={m}>{m === "all" ? "all methods" : m}</option>)}
            </select>
            <div className="relative min-w-[200px] flex-1">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-faint" />
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter by route or service" className="h-9 w-full rounded-lg border border-border bg-surface pl-9 pr-3 text-[13px] outline-none placeholder:text-faint focus:border-brand/40" />
            </div>
          </div>

          <Card>
            <CardHead title="Recent requests" sub={`${d.service === "all" ? "all instrumented services" : d.service} · last 1h`} right={<Badge tone="neutral">{rows.length}</Badge>} />
            <ErrorNote error={d.error} />
            {d.capped ? <div className="px-4 pt-2 text-2xs text-faint">Showing the newest {rows.length} requests from the last hour — filter by service to see a specific one in full.</div> : null}
            {rows.length === 0 ? (
              <Empty title="No matching requests">Adjust the filters or widen the service selection.</Empty>
            ) : (
              <div className="max-h-[64vh] overflow-auto scroll-thin">
                <table className="w-full text-[13px]">
                  <thead className="sticky top-0 bg-surface">
                    <tr className="border-b border-border text-left text-2xs uppercase tracking-wide text-faint">
                      <th className="px-4 py-2 font-medium">Time</th>
                      <th className="px-4 py-2 font-medium">Service</th>
                      <th className="px-4 py-2 font-medium">Method</th>
                      <th className="px-4 py-2 font-medium">Route</th>
                      <th className="px-4 py-2 text-right font-medium">Status</th>
                      <th className="px-4 py-2 text-right font-medium">Latency</th>
                      <th className="px-4 py-2"></th>
                    </tr>
                  </thead>
                  <tbody className="font-mono">
                    {rows.map((r, i) => (
                      <tr key={r.traceID + i} className="border-b border-border/40 last:border-0 hover:bg-surface-2/50">
                        <td className="px-4 py-1.5 tabular-nums text-faint">{fmtClock(r.startMs)}</td>
                        <td className="px-4 py-1.5 text-accent">{r.service}</td>
                        <td className="px-4 py-1.5 font-semibold text-muted">{r.method || "—"}</td>
                        <td className="max-w-[360px] truncate px-4 py-1.5 text-fg/90">{r.route}</td>
                        <td className={cn("px-4 py-1.5 text-right font-semibold tabular-nums", statusTone(r.status))}>{r.status ?? "—"}</td>
                        <td className={cn("px-4 py-1.5 text-right tabular-nums", r.durationMs >= 1000 ? "text-err" : r.durationMs >= 500 ? "text-warn" : "text-muted")}>{fmtMs(r.durationMs)}</td>
                        <td className="px-4 py-1.5 text-right"><Link to={`/traces/${r.traceID}`} className="text-2xs text-brand hover:underline">trace</Link></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </>
      )}
    </div>
  );
}
