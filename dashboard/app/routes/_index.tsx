import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { Link, useLoaderData } from "@remix-run/react";
import { Activity, ArrowRight, Boxes, CheckCircle2, Gauge, TriangleAlert, Zap } from "lucide-react";
import { Badge, Card, CardHead, Empty, PageTitle, StatusDot, StatusPill } from "~/components/ui";
import { AreaSeries } from "~/components/charts";
import * as analysis from "~/lib/analysis.server";
import * as apm from "~/lib/apm.server";
import * as vm from "~/lib/vm.server";
import * as loki from "~/lib/loki.server";
import { safe } from "~/lib/config.server";
import { cached } from "~/lib/cache.server";
import { cn, fmtBytes, fmtBytesRate, fmtCores, fmtMs, fmtNum, fmtPct, fmtRate } from "~/lib/utils";

export async function loader(_args: LoaderFunctionArgs) {
  const end = Date.now();
  const start = end - 60 * 60 * 1000;
  const health = await safe(() => analysis.serviceHealth(), [] as analysis.ServiceHealth[]);
  const [incidents, apmData, logVol, cpuTrend] = await Promise.all([
    safe(() => analysis.getIncidents(), [] as analysis.Incident[]),
    safe(() => apm.getAPM(1), { byService: [], topOps: [], totals: { reqRate: 0, errorRatePct: 0, worstP95: 0, services: 0 } } as Awaited<ReturnType<typeof apm.getAPM>>),
    safe(() => cached("ov:logvol", 12000, () => loki.countOverTime('sum(count_over_time({service=~".+"}[1m]))', { start, end, step: "120s" })), [] as Array<{ t: number; v: number; labels: Record<string, string> }>),
    safe(() => cached("ov:cputrend", 12000, () => vm.range('sum(rate(container_cpu_usage_seconds_total{name!=""}[5m]))', { start, end, step: "120s" })), [] as vm.Series[]),
  ]);
  const summary = await analysis.hostSummary(health.data);
  return json({
    health: health.data,
    healthErr: health.error,
    incidents: incidents.data,
    apm: apmData.data.totals,
    summary,
    logVol: logVol.data.map((p) => ({ t: p.t, v: p.v })),
    cpuTrend: (cpuTrend.data[0]?.points ?? []).map((p) => ({ t: p.t, v: p.v })),
  });
}

function SummaryCard({ icon: Icon, label, value, sub, tone, to }: { icon: any; label: string; value: string; sub?: string; tone?: string; to?: string }) {
  const inner = (
    <Card className="flex h-full items-center gap-3 px-4 py-3.5 transition-colors hover:bg-surface-2/40">
      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-surface-2 text-muted">
        <Icon className="h-4 w-4" />
      </span>
      <div className="min-w-0">
        <div className="text-2xs uppercase tracking-wide text-faint">{label}</div>
        <div className={cn("font-mono text-xl font-semibold leading-tight tabular-nums", tone)}>{value}</div>
        {sub ? <div className="truncate text-2xs text-faint">{sub}</div> : null}
      </div>
    </Card>
  );
  return to ? <Link to={to} className="block">{inner}</Link> : inner;
}

function Vital({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="px-4 py-3 first:pl-4">
      <div className="text-2xs uppercase tracking-wide text-faint">{label}</div>
      <div className={cn("mt-1 font-mono text-lg font-semibold tabular-nums", tone)}>{value}</div>
    </div>
  );
}

export default function Overview() {
  const d = useLoaderData<typeof loader>();
  const s = d.summary;
  const attention = d.health.filter((h) => h.status === "down" || h.status === "degraded");
  const up = s.servicesActive - s.servicesDown - s.servicesDegraded;
  const critical = d.incidents.filter((i) => i.severity === "critical").length;
  const a = d.apm;

  return (
    <div className="space-y-6 animate-fade-in">
      <PageTitle title="Overview" sub="What's healthy and what needs attention across every container on this host, in one place." />

      {/* summary cards */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
        <SummaryCard icon={Boxes} label="Services up" value={`${up}/${s.servicesActive}`}
          sub={`${s.servicesDown} down · ${s.servicesDegraded} degraded · ${s.servicesStopped} stopped`}
          tone={s.servicesDown > 0 ? "text-err" : s.servicesDegraded > 0 ? "text-warn" : "text-ok"} />
        <SummaryCard icon={Gauge} label="Request rate" value={a.services ? fmtRate(a.reqRate) : "—"}
          sub={a.services ? `${a.services} instrumented service${a.services > 1 ? "s" : ""}` : "instrument an app"} />
        <SummaryCard icon={TriangleAlert} label="Error rate" value={a.services ? fmtPct(a.errorRatePct) : "—"}
          sub="of traced requests" tone={a.errorRatePct >= 5 ? "text-err" : a.errorRatePct >= 1 ? "text-warn" : undefined} />
        <SummaryCard icon={Zap} label="Worst p95" value={a.services ? fmtMs(a.worstP95) : "—"}
          sub="tail latency" tone={a.worstP95 >= 1000 ? "text-err" : a.worstP95 >= 500 ? "text-warn" : undefined} />
        <SummaryCard icon={Activity} label="Active incidents" value={String(d.incidents.length)}
          sub={`${critical} critical`} tone={critical > 0 ? "text-err" : d.incidents.length > 0 ? "text-warn" : "text-ok"} to="/incidents" />
      </div>

      {/* container vitals strip */}
      <Card>
        <div className="flex flex-wrap items-center divide-x divide-border">
          <Vital label="Active services" value={String(s.servicesActive)} />
          <Vital label="Down" value={String(s.servicesDown)} tone={s.servicesDown > 0 ? "text-err" : "text-muted"} />
          <Vital label="Degraded" value={String(s.servicesDegraded)} tone={s.servicesDegraded > 0 ? "text-warn" : "text-muted"} />
          <Vital label="Stopped" value={String(s.servicesStopped)} tone="text-faint" />
          <Vital label="CPU" value={`${fmtCores(s.cpuCores)} cores`} />
          <Vital label="Memory" value={fmtBytes(s.memBytes)} />
          <Vital label="Logs" value={`${fmtNum(s.logRate, 1)}/s`} />
          <Vital label="Errors" value={`${fmtNum(s.errorRate, 2)}/s`} tone={s.errorRate >= 0.2 ? "text-err" : "text-muted"} />
        </div>
      </Card>

      {/* needs attention + log trend */}
      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHead title="Needs attention" sub="services not fully operational, worst first" right={<Link to="/incidents" className="text-2xs font-medium text-brand hover:underline">Incidents</Link>} />
          {attention.length === 0 && d.incidents.length === 0 ? (
            <div className="flex items-center gap-3 px-4 py-8">
              <CheckCircle2 className="h-5 w-5 text-ok" />
              <div>
                <p className="text-sm font-medium">All systems operational</p>
                <p className="text-[13px] text-muted">No down or degraded services, no open incidents.</p>
              </div>
            </div>
          ) : (
            <ul className="divide-y divide-border">
              {attention.slice(0, 8).map((h) => (
                <li key={h.service} className="flex items-center gap-3 px-4 py-2.5">
                  <StatusDot status={h.status} pulse />
                  <Link to={`/logs?service=${encodeURIComponent(h.service)}`} className="font-medium hover:text-brand">{h.service}</Link>
                  {h.project ? <Badge>{h.project}</Badge> : null}
                  <span className="ml-auto truncate text-[13px] text-muted">{h.reasons[0] ?? "degraded"}</span>
                  <span className="font-mono text-2xs tabular-nums text-faint">{h.running}/{h.containers} up</span>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card>
          <CardHead title="Host load" sub="CPU cores in use, 1h" />
          <div className="px-3 pb-2 pt-3">
            <AreaSeries points={d.cpuTrend} color="oklch(0.55 0.17 290)" height={92} fmt={(n) => fmtCores(n)} />
          </div>
          <div className="border-t border-border px-4 py-3">
            <div className="flex items-center justify-between text-[13px]">
              <span className="text-muted">Memory in use</span>
              <span className="font-mono font-medium tabular-nums">{fmtBytes(s.memBytes)}</span>
            </div>
          </div>
        </Card>
      </div>

      {/* service health table */}
      <Card>
        <CardHead
          title="Services"
          sub={`${d.health.length} services · status, resources, throughput`}
          right={<Link to="/containers" className="inline-flex items-center gap-1 text-2xs font-medium text-brand hover:underline">All containers <ArrowRight className="h-3 w-3" /></Link>}
        />
        {d.healthErr ? <Empty title="Metrics unavailable">{d.healthErr}</Empty> : d.health.length === 0 ? (
          <Empty title="No containers reporting">Telemetry appears within ~30s of the first scrape.</Empty>
        ) : (
          <div className="overflow-x-auto scroll-thin">
            <table className="w-full text-[13px]">
              <thead>
                <tr className="border-b border-border text-left text-2xs uppercase tracking-wide text-faint">
                  <th className="px-4 py-2 font-medium">Service</th>
                  <th className="px-4 py-2 font-medium">Status</th>
                  <th className="px-4 py-2 text-right font-medium">CPU</th>
                  <th className="px-4 py-2 text-right font-medium">Memory</th>
                  <th className="px-4 py-2 text-right font-medium">Net I/O</th>
                  <th className="px-4 py-2 text-right font-medium">Restarts</th>
                  <th className="px-4 py-2 text-right font-medium">Logs/s</th>
                  <th className="px-4 py-2 text-right font-medium">Err/s</th>
                </tr>
              </thead>
              <tbody>
                {d.health.slice(0, 14).map((h) => (
                  <tr key={h.service} className="border-b border-border/60 last:border-0 hover:bg-surface-2/50">
                    <td className="max-w-[260px] px-4 py-2.5">
                      <Link to={`/logs?service=${encodeURIComponent(h.service)}`} className="truncate font-medium hover:text-brand">{h.service}</Link>
                      {h.containers > 1 ? <span className="ml-2 text-2xs text-faint">×{h.containers}</span> : null}
                    </td>
                    <td className="px-4 py-2.5"><StatusPill status={h.status} /></td>
                    <td className="px-4 py-2.5 text-right font-mono tabular-nums text-muted">{fmtCores(h.cpuCores)}</td>
                    <td className="px-4 py-2.5 text-right font-mono tabular-nums text-muted">{fmtBytes(h.memBytes)}</td>
                    <td className="px-4 py-2.5 text-right font-mono text-2xs tabular-nums text-faint">{fmtBytesRate(h.netRxRate)} ↓ {fmtBytesRate(h.netTxRate)} ↑</td>
                    <td className={cn("px-4 py-2.5 text-right font-mono tabular-nums", h.restarts > 0 ? "text-warn" : "text-faint")}>{h.restarts || "—"}</td>
                    <td className="px-4 py-2.5 text-right font-mono tabular-nums text-muted">{fmtNum(h.logRate, 1)}</td>
                    <td className={cn("px-4 py-2.5 text-right font-mono tabular-nums", h.errorRate > 0 ? "text-err" : "text-faint")}>{h.errorRate > 0 ? fmtNum(h.errorRate, 2) : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* log volume */}
      <Card>
        <CardHead title="Log volume" sub="lines/min across all sources, errors overlaid, 1h" right={<Link to="/logs" className="text-2xs font-medium text-brand hover:underline">Search logs</Link>} />
        <div className="p-3">
          <AreaSeries points={d.logVol} color="oklch(0.58 0.13 240)" height={150} fmt={(n) => fmtNum(n, 0)} />
        </div>
      </Card>
    </div>
  );
}
