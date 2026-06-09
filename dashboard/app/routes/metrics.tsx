import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import { Card, CardHeader, Empty } from "~/components/ui";
import { PALETTE, TimeSeries } from "~/components/charts";
import * as vm from "~/lib/vm.server";
import * as jaeger from "~/lib/jaeger.server";
import { safe } from "~/lib/config.server";
import { cn, fmtMs, fmtNum, fmtPct } from "~/lib/utils";

async function single(query: string, name: string, mul = 1, start?: number, end?: number) {
  const s = await vm.range(query, { start, end, step: "60s" });
  const pts = (s[0]?.points ?? []).map((p) => ({ t: p.t, v: p.v * mul }));
  return { name, points: pts };
}

export async function loader(_args: LoaderFunctionArgs) {
  const end = Date.now();
  const start = end - 60 * 60 * 1000;

  const [reqBy, errBy, cpuBy, memBy, p50, p95, p99, endpoints, eP95, deps] = await Promise.all([
    safe(() => vm.range("sum by (service)(rate(http_requests_total[1m]))", { start, end, step: "60s" }), [] as vm.Series[]),
    safe(
      () =>
        vm.range(
          '100 * sum by (service)(rate(http_requests_total{status=~"5.."}[5m])) / clamp_min(sum by (service)(rate(http_requests_total[5m])),0.001)',
          { start, end, step: "60s" }
        ),
      [] as vm.Series[]
    ),
    safe(() => vm.range("sum by (service)(rate(process_cpu_seconds_total[2m]))", { start, end, step: "60s" }), [] as vm.Series[]),
    safe(() => vm.range("sum by (service)(process_resident_memory_bytes)/1024/1024", { start, end, step: "60s" }), [] as vm.Series[]),
    safe(() => single("histogram_quantile(0.50, sum by (le)(rate(http_request_duration_seconds_bucket[5m])))", "p50", 1000, start, end), { name: "p50", points: [] }),
    safe(() => single("histogram_quantile(0.95, sum by (le)(rate(http_request_duration_seconds_bucket[5m])))", "p95", 1000, start, end), { name: "p95", points: [] }),
    safe(() => single("histogram_quantile(0.99, sum by (le)(rate(http_request_duration_seconds_bucket[5m])))", "p99", 1000, start, end), { name: "p99", points: [] }),
    safe(() => vm.instant("topk(10, sum by (service, route)(rate(http_requests_total[5m])))"), [] as any[]),
    safe(() => vm.instant("histogram_quantile(0.95, sum by (service, route, le)(rate(http_request_duration_seconds_bucket[5m])))"), [] as any[]),
    safe(() => jaeger.dependencies(24), [] as Array<{ parent: string; child: string; callCount: number }>),
  ]);

  // join endpoint throughput with its p95
  const p95map: Record<string, number> = {};
  for (const r of eP95.data) p95map[`${r.metric.service}|${r.metric.route}`] = r.value * 1000;
  const endpointRows = endpoints.data
    .map((r: any) => ({
      service: r.metric.service || "?",
      route: r.metric.route || "?",
      rps: r.value,
      p95: p95map[`${r.metric.service}|${r.metric.route}`] || 0,
    }))
    .sort((a, b) => b.rps - a.rps);

  return json({
    reqBy: reqBy.data,
    errBy: errBy.data,
    cpuBy: cpuBy.data,
    memBy: memBy.data,
    latency: [p50.data, p95.data, p99.data],
    endpointRows,
    deps: deps.data,
  });
}

function byService(series: vm.Series[]) {
  return series.map((s, i) => ({ name: s.metric.service || "series", color: PALETTE[i % PALETTE.length], points: s.points }));
}

export default function Metrics() {
  const d = useLoaderData<typeof loader>();
  const latency = d.latency.map((s, i) => ({ name: s.name, color: ["#3fb950", "#d8a657", "#f85149"][i], points: s.points }));

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-lg font-semibold">Metrics &amp; Performance</h1>
        <p className="text-sm text-muted">Throughput, latency percentiles, errors and resource usage — pulled from VictoriaMetrics.</p>
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        <Card>
          <CardHeader title="Request rate" subtitle="req/s by service" />
          <div className="p-2"><TimeSeries series={byService(d.reqBy)} height={200} unit="/s" /></div>
        </Card>
        <Card>
          <CardHeader title="Latency percentiles" subtitle="p50 / p95 / p99 · ms" />
          <div className="p-2"><TimeSeries series={latency} height={200} unit="ms" /></div>
        </Card>
        <Card>
          <CardHeader title="Error rate" subtitle="% 5xx by service" />
          <div className="p-2"><TimeSeries series={byService(d.errBy)} height={200} unit="%" /></div>
        </Card>
        <Card>
          <CardHeader title="Memory" subtitle="resident MB by service" />
          <div className="p-2"><TimeSeries series={byService(d.memBy)} height={200} unit="MB" /></div>
        </Card>
      </div>

      <div className="grid gap-3 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader title="Top endpoints" subtitle="throughput + tail latency · 5m" />
          {d.endpointRows.length === 0 ? (
            <Empty>No endpoint metrics yet.</Empty>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-[11px] uppercase tracking-wide text-muted">
                  <th className="px-4 py-2 font-medium">Service</th>
                  <th className="px-4 py-2 font-medium">Route</th>
                  <th className="px-4 py-2 text-right font-medium">Req/s</th>
                  <th className="px-4 py-2 text-right font-medium">p95</th>
                </tr>
              </thead>
              <tbody>
                {d.endpointRows.map((r, i) => (
                  <tr key={i} className="border-b border-border/40 last:border-0 hover:bg-panel-2/40">
                    <td className="px-4 py-2 text-accent">{r.service}</td>
                    <td className="px-4 py-2 font-mono">{r.route}</td>
                    <td className="px-4 py-2 text-right font-mono tabular-nums">{fmtNum(r.rps, 2)}</td>
                    <td className={cn("px-4 py-2 text-right font-mono tabular-nums", r.p95 >= 1000 ? "text-err" : r.p95 >= 500 ? "text-warn" : "")}>{fmtMs(r.p95)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>

        <Card className="lg:col-span-1">
          <CardHeader title="Service dependencies" subtitle="who calls whom · 24h" />
          {d.deps.length === 0 ? (
            <Empty>Dependency graph builds from traces over time.</Empty>
          ) : (
            <ul className="divide-y divide-border/40">
              {d.deps.map((e, i) => (
                <li key={i} className="flex items-center gap-2 px-4 py-2.5 text-sm">
                  <span className="text-fg">{e.parent}</span>
                  <span className="text-muted">→</span>
                  <span className="text-accent">{e.child}</span>
                  <span className="ml-auto font-mono text-xs text-muted">{fmtNum(e.callCount, 0)} calls</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}
