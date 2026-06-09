import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { Link, useLoaderData } from "@remix-run/react";
import { AlertTriangle, ArrowUpRight, Boxes, TrendingUp, Zap } from "lucide-react";
import { Badge, Card, CardHeader, Empty, StatusDot } from "~/components/ui";
import { AreaSeries, PALETTE, TimeSeries } from "~/components/charts";
import * as analysis from "~/lib/analysis.server";
import * as vm from "~/lib/vm.server";
import * as loki from "~/lib/loki.server";
import { safe } from "~/lib/config.server";
import { cn, fmtMs, fmtNum, fmtPct, fmtRate, fmtBytesMB, timeAgo } from "~/lib/utils";

export async function loader(_args: LoaderFunctionArgs) {
  const end = Date.now();
  const start = end - 60 * 60 * 1000;
  const [health, incidents, anomalies, reqSeries, errSeries, logVol] = await Promise.all([
    safe(() => analysis.serviceHealth(), [] as analysis.ServiceHealth[]),
    safe(() => analysis.getIncidents(6), [] as analysis.Incident[]),
    safe(() => analysis.getAnomalies(), [] as analysis.Anomaly[]),
    safe(() => vm.range("sum by (service)(rate(http_requests_total[1m]))", { start, end, step: "60s" }), [] as vm.Series[]),
    safe(
      () =>
        vm.range(
          '100 * sum(rate(http_requests_total{status=~"5.."}[5m])) / clamp_min(sum(rate(http_requests_total[5m])),0.001)',
          { start, end, step: "60s" }
        ),
      [] as vm.Series[]
    ),
    safe(
      () => loki.countOverTime('sum(count_over_time({service=~".+"}[1m]))', { start, end, step: "60s" }),
      [] as Array<{ t: number; v: number; labels: Record<string, string> }>
    ),
  ]);

  const h = health.data;
  const totalReq = h.reduce((a, s) => a + s.reqRate, 0);
  const totalErrReq = h.reduce((a, s) => a + (s.reqRate * s.errorRatePct) / 100, 0);
  const overallErr = totalReq > 0 ? (totalErrReq / totalReq) * 100 : 0;
  const worstP95 = h.reduce((a, s) => Math.max(a, s.p95Ms), 0);
  const upCount = h.filter((s) => s.status === "up").length;

  return json({
    health: h,
    healthErr: health.error,
    incidents: incidents.data.slice(0, 6),
    anomalies: anomalies.data,
    totals: { totalReq, overallErr, worstP95, upCount, total: h.length },
    reqSeries: reqSeries.data,
    errSeries: errSeries.data,
    logVol: logVol.data.map((p) => ({ t: p.t, v: p.v })),
  });
}

function GlobalStat({ icon: Icon, label, value, tone }: { icon: any; label: string; value: string; tone?: string }) {
  return (
    <Card className="flex items-center gap-3 px-4 py-3.5">
      <div className="grid h-9 w-9 place-items-center rounded-md bg-panel-2 text-muted">
        <Icon className="h-4 w-4" />
      </div>
      <div>
        <div className="text-[11px] uppercase tracking-wide text-muted">{label}</div>
        <div className={cn("font-mono text-xl font-semibold tabular-nums", tone)}>{value}</div>
      </div>
    </Card>
  );
}

export default function Overview() {
  const d = useLoaderData<typeof loader>();
  const reqSeries = d.reqSeries.map((s, i) => ({
    name: s.metric.service || "series",
    color: PALETTE[i % PALETTE.length],
    points: s.points,
  }));
  const errPoints = d.errSeries[0]?.points ?? [];

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-lg font-semibold">Service Health</h1>
        <p className="text-sm text-muted">One screen tells you what is broken right now — across logs, metrics and traces.</p>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <GlobalStat icon={Boxes} label="Services up" value={`${d.totals.upCount}/${d.totals.total}`} tone={d.totals.upCount === d.totals.total ? "text-ok" : "text-warn"} />
        <GlobalStat icon={TrendingUp} label="Request rate" value={fmtRate(d.totals.totalReq)} />
        <GlobalStat icon={AlertTriangle} label="Error rate" value={fmtPct(d.totals.overallErr)} tone={d.totals.overallErr >= 5 ? "text-err" : d.totals.overallErr >= 1 ? "text-warn" : "text-ok"} />
        <GlobalStat icon={Zap} label="Worst p95" value={fmtMs(d.totals.worstP95)} tone={d.totals.worstP95 >= 1000 ? "text-err" : d.totals.worstP95 >= 500 ? "text-warn" : "text-fg"} />
      </div>

      <div className="grid gap-3 lg:grid-cols-3">
        <Card className="lg:col-span-1">
          <CardHeader title="Request rate" subtitle="req/s by service · 1h" />
          <div className="p-2"><TimeSeries series={reqSeries} height={190} unit="/s" /></div>
        </Card>
        <Card className="lg:col-span-1">
          <CardHeader title="Error rate" subtitle="% of 5xx · 1h" />
          <div className="p-2"><AreaSeries points={errPoints} color="#f85149" height={190} unit="%" /></div>
        </Card>
        <Card className="lg:col-span-1">
          <CardHeader title="Log volume" subtitle="lines/min · all sources · 1h" />
          <div className="p-2"><AreaSeries points={d.logVol} color="#58a6ff" height={190} /></div>
        </Card>
      </div>

      <div className="grid gap-3 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader title="Services" subtitle="status · throughput · errors · latency · resources" right={<Link to="/metrics" className="text-xs text-brand hover:underline">Metrics →</Link>} />
          {d.health.length === 0 ? (
            <Empty>No services reporting yet. Metrics appear within ~30s of the first scrape.</Empty>
          ) : (
            <div className="overflow-x-auto scroll-thin">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-[11px] uppercase tracking-wide text-muted">
                    <th className="px-4 py-2 font-medium">Service</th>
                    <th className="px-4 py-2 font-medium">Status</th>
                    <th className="px-4 py-2 text-right font-medium">Req/s</th>
                    <th className="px-4 py-2 text-right font-medium">Errors</th>
                    <th className="px-4 py-2 text-right font-medium">p50</th>
                    <th className="px-4 py-2 text-right font-medium">p95</th>
                    <th className="px-4 py-2 text-right font-medium">CPU</th>
                    <th className="px-4 py-2 text-right font-medium">Mem</th>
                  </tr>
                </thead>
                <tbody>
                  {d.health.map((s) => (
                    <tr key={s.service} className="border-b border-border/50 last:border-0 hover:bg-panel-2/40">
                      <td className="px-4 py-2.5 font-medium">
                        <Link to={`/logs?service=${s.service}`} className="hover:text-brand">{s.service}</Link>
                        {s.restarts > 0 ? <Badge tone="warn" className="ml-2">{s.restarts}× restart</Badge> : null}
                      </td>
                      <td className="px-4 py-2.5"><StatusDot status={s.status} pulse /></td>
                      <td className="px-4 py-2.5 text-right font-mono tabular-nums">{fmtNum(s.reqRate, 2)}</td>
                      <td className={cn("px-4 py-2.5 text-right font-mono tabular-nums", s.errorRatePct >= 5 ? "text-err" : s.errorRatePct >= 1 ? "text-warn" : "text-muted")}>{fmtPct(s.errorRatePct)}</td>
                      <td className="px-4 py-2.5 text-right font-mono tabular-nums text-muted">{fmtMs(s.p50Ms)}</td>
                      <td className={cn("px-4 py-2.5 text-right font-mono tabular-nums", s.p95Ms >= 1000 ? "text-err" : s.p95Ms >= 500 ? "text-warn" : "")}>{fmtMs(s.p95Ms)}</td>
                      <td className="px-4 py-2.5 text-right font-mono tabular-nums text-muted">{fmtNum(s.cpuCores, 2)}</td>
                      <td className="px-4 py-2.5 text-right font-mono tabular-nums text-muted">{fmtBytesMB(s.memMB)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        <Card className="lg:col-span-1">
          <CardHeader title="Active incidents" subtitle="auto-detected · 6h" right={<Link to="/incidents" className="text-xs text-brand hover:underline">All →</Link>} />
          {d.incidents.length === 0 && d.anomalies.length === 0 ? (
            <Empty>No incidents detected. All clear.</Empty>
          ) : (
            <ul className="divide-y divide-border/50">
              {d.incidents.map((i) => (
                <li key={i.id} className="flex items-start gap-2.5 px-4 py-2.5">
                  <span className={cn("mt-1 h-2 w-2 shrink-0 rounded-full", i.severity === "critical" ? "bg-err" : "bg-warn")} />
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 text-sm font-medium">{i.title}</div>
                    <div className="truncate text-xs text-muted">{i.detail}</div>
                    <div className="mt-0.5 text-[11px] text-muted">{timeAgo(i.ts)}</div>
                  </div>
                </li>
              ))}
              {d.anomalies.map((a, idx) => (
                <li key={"an" + idx} className="flex items-start gap-2.5 px-4 py-2.5">
                  <ArrowUpRight className="mt-0.5 h-3.5 w-3.5 shrink-0 text-accent" />
                  <div className="min-w-0">
                    <div className="text-sm font-medium">{a.service}: {a.metric}</div>
                    <div className="text-xs text-muted">{a.deltaPct > 0 ? "+" : ""}{a.deltaPct.toFixed(0)}% vs 1h baseline</div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}
