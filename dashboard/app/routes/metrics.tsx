import type { LoaderFunctionArgs } from "@remix-run/node";
import { defer } from "@remix-run/node";
import { Link, useLoaderData } from "@remix-run/react";
import { Card, CardHead, Empty, PageTitle } from "~/components/ui";
import { ChartSkeleton, Deferred, RowsSkeleton } from "~/components/defer";
import { PALETTE, TimeSeries } from "~/components/charts";
import * as vm from "~/lib/vm.server";
import * as apm from "~/lib/apm.server";
import * as jaeger from "~/lib/jaeger.server";
import { requireOrg } from "~/lib/auth/context.server";
import { tenantOf } from "~/lib/tenant.server";
import { cn, fmtBytes, fmtBytesRate, fmtCores, fmtMs, fmtNum, fmtPct } from "~/lib/utils";

const KEY = "container_label_coolify_resourceName";

export async function loader({ request }: LoaderFunctionArgs) {
  const ctx = await requireOrg(request);
  const t = tenantOf(ctx.org.id);
  const end = Date.now();
  const start = end - 60 * 60 * 1000;
  const named = (rows: vm.Series[]) => rows.map((r, i) => ({ name: r.metric[KEY] || "other", color: PALETTE[i % PALETTE.length], points: r.points }));

  const cadvisor = Promise.all([
    vm.range(`topk(7, sum by (${KEY})(rate(container_cpu_usage_seconds_total{name!=""}[5m])))`, { start, end, step: "120s" }, t),
    vm.range(`topk(7, sum by (${KEY})(container_memory_working_set_bytes{name!=""}))`, { start, end, step: "120s" }, t),
    vm.range(`sum(rate(container_network_receive_bytes_total{name!=""}[5m]))`, { start, end, step: "120s" }, t),
    vm.range(`sum(rate(container_network_transmit_bytes_total{name!=""}[5m]))`, { start, end, step: "120s" }, t),
    vm.instant(`topk(10, sum by (${KEY})(rate(container_cpu_usage_seconds_total{name!=""}[5m])))`, undefined, t),
    vm.instant(`topk(10, sum by (${KEY})(container_memory_working_set_bytes{name!=""}))`, undefined, t),
  ]).then(([cpuTop, memTop, netRx, netTx, cpuNow, memNow]) => ({
    cpuTop: named(cpuTop),
    memTop: named(memTop),
    net: [
      { name: "rx", color: PALETTE[1], points: netRx[0]?.points ?? [] },
      { name: "tx", color: PALETTE[0], points: netTx[0]?.points ?? [] },
    ],
    cpuNow: cpuNow.map((r) => ({ name: r.metric[KEY] || "other", v: r.value })).sort((a, b) => b.v - a.v),
    memNow: memNow.map((r) => ({ name: r.metric[KEY] || "other", v: r.value })).sort((a, b) => b.v - a.v),
    empty: cpuTop.length === 0 && memTop.length === 0,
  }));

  return defer({
    cadvisor,
    apm: apm.getAPM(1, t),
    deps: jaeger.dependencies(24, t).catch(() => [] as Array<{ parent: string; child: string; callCount: number }>),
  });
}

function ConsumerTable({ title, rows, fmt, unit }: { title: string; rows: { name: string; v: number }[]; fmt: (n: number) => string; unit?: string }) {
  const max = rows[0]?.v || 1;
  return (
    <Card>
      <CardHead title={title} sub="top 10, last 5m" />
      {rows.length === 0 ? <Empty title="No data" /> : (
        <ul className="divide-y divide-border">
          {rows.map((r) => (
            <li key={r.name} className="relative flex items-center gap-3 px-4 py-2">
              <div className="absolute inset-y-0 left-0 bg-brand/[0.06]" style={{ width: `${(r.v / max) * 100}%` }} aria-hidden />
              <Link to={`/logs?service=${encodeURIComponent(r.name)}`} className="relative z-10 min-w-0 flex-1 truncate text-[13px] font-medium hover:text-brand">{r.name}</Link>
              <span className="relative z-10 font-mono text-[13px] tabular-nums text-muted">{fmt(r.v)}{unit}</span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

export default function Metrics() {
  const d = useLoaderData<typeof loader>();
  return (
    <div className="space-y-5 animate-fade-in">
      <PageTitle title="Metrics" sub="Real per-container CPU, memory and network from cAdvisor. Resource pressure and the heaviest consumers, at a glance." />

      <Deferred resolve={d.cadvisor} fallback={<div className="grid gap-4 xl:grid-cols-2"><Card><ChartSkeleton height={210} /></Card><Card><ChartSkeleton height={210} /></Card></div>}>
        {(c) =>
          c.empty ? (
            <Card><Empty title="No metrics yet">cAdvisor populates within ~30s of the first scrape.</Empty></Card>
          ) : (
            <div className="space-y-4">
              <div className="grid gap-4 xl:grid-cols-2">
                <Card><CardHead title="CPU usage" sub="cores by service, top 7, 1h" /><div className="p-3"><TimeSeries series={c.cpuTop} height={210} fmt={(n) => fmtCores(n)} /></div></Card>
                <Card><CardHead title="Memory" sub="working set by service, top 7, 1h" /><div className="p-3"><TimeSeries series={c.memTop} height={210} fmt={(n) => fmtBytes(n)} /></div></Card>
              </div>
              <Card><CardHead title="Network throughput" sub="host total, receive vs transmit, 1h" /><div className="p-3"><TimeSeries series={c.net} height={170} fmt={(n) => fmtBytesRate(n)} /></div></Card>
              <div className="grid gap-4 xl:grid-cols-2">
                <ConsumerTable title="Top CPU consumers" rows={c.cpuNow} fmt={(n) => fmtCores(n) + " cores"} />
                <ConsumerTable title="Top memory consumers" rows={c.memNow} fmt={(n) => fmtBytes(n)} />
              </div>
            </div>
          )
        }
      </Deferred>

      <div className="pt-1">
        <h2 className="mb-2 text-[13px] font-semibold">Application performance <span className="font-normal text-faint">· derived from traces</span></h2>
        <Deferred resolve={d.apm} fallback={<Card><RowsSkeleton rows={4} /></Card>}>
          {(a) =>
            a.byService.length === 0 ? (
              <Card><Empty title="No instrumented services">Services that emit OpenTelemetry spans show request rate, latency percentiles and errors here.</Empty></Card>
            ) : (
              <div className="space-y-4">
                <Card>
                  <CardHead title="Latency & errors by service" sub="request rate, error rate and p50/p95/p99, from traces · 1h" />
                  <div className="overflow-x-auto scroll-thin">
                    <table className="w-full text-[13px]">
                      <thead><tr className="border-b border-border text-left text-2xs uppercase tracking-wide text-faint"><th className="px-4 py-2 font-medium">Service</th><th className="px-4 py-2 text-right font-medium">Req/s</th><th className="px-4 py-2 text-right font-medium">Errors</th><th className="px-4 py-2 text-right font-medium">p50</th><th className="px-4 py-2 text-right font-medium">p95</th><th className="px-4 py-2 text-right font-medium">p99</th></tr></thead>
                      <tbody>
                        {a.byService.map((s) => (
                          <tr key={s.service} className="border-b border-border/60 last:border-0 hover:bg-surface-2/50">
                            <td className="px-4 py-2.5 font-medium text-accent">{s.service}</td>
                            <td className="px-4 py-2.5 text-right font-mono tabular-nums text-muted">{fmtNum(s.reqRate, 2)}</td>
                            <td className={cn("px-4 py-2.5 text-right font-mono tabular-nums", s.errorRatePct >= 5 ? "text-err" : s.errorRatePct >= 1 ? "text-warn" : "text-muted")}>{fmtPct(s.errorRatePct)}</td>
                            <td className="px-4 py-2.5 text-right font-mono tabular-nums text-muted">{fmtMs(s.p50)}</td>
                            <td className={cn("px-4 py-2.5 text-right font-mono tabular-nums", s.p95 >= 1000 ? "text-err" : s.p95 >= 500 ? "text-warn" : "")}>{fmtMs(s.p95)}</td>
                            <td className="px-4 py-2.5 text-right font-mono tabular-nums text-muted">{fmtMs(s.p99)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </Card>
                <div className="grid gap-4 xl:grid-cols-2">
                  <Card>
                    <CardHead title="Top endpoints" sub="busiest operations · 1h" />
                    {a.topOps.length === 0 ? <Empty title="No operations" /> : (
                      <table className="w-full text-[13px]">
                        <thead><tr className="border-b border-border text-left text-2xs uppercase tracking-wide text-faint"><th className="px-4 py-2 font-medium">Operation</th><th className="px-4 py-2 text-right font-medium">Req/s</th><th className="px-4 py-2 text-right font-medium">p95</th></tr></thead>
                        <tbody>
                          {a.topOps.map((o, i) => (
                            <tr key={i} className="border-b border-border/40 last:border-0 hover:bg-surface-2/50">
                              <td className="px-4 py-2.5"><span className="text-accent">{o.service}</span> <span className="font-mono text-muted">{o.op}</span></td>
                              <td className="px-4 py-2.5 text-right font-mono tabular-nums text-muted">{fmtNum(o.reqRate, 2)}</td>
                              <td className={cn("px-4 py-2.5 text-right font-mono tabular-nums", o.p95 >= 1000 ? "text-err" : o.p95 >= 500 ? "text-warn" : "")}>{fmtMs(o.p95)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                  </Card>
                  <Card>
                    <CardHead title="Service dependencies" sub="who calls whom · 24h" />
                    <Deferred resolve={d.deps} fallback={<RowsSkeleton rows={3} />}>
                      {(deps) =>
                        deps.length === 0 ? (
                          <Empty title="No dependencies yet">Cross-service calls appear once two or more services are instrumented.</Empty>
                        ) : (
                          <ul className="divide-y divide-border/40">
                            {deps.map((e, i) => (
                              <li key={i} className="flex items-center gap-2 px-4 py-2.5 text-[13px]"><span>{e.parent}</span><span className="text-faint">→</span><span className="text-accent">{e.child}</span><span className="ml-auto font-mono text-2xs text-muted">{fmtNum(e.callCount, 0)} calls</span></li>
                            ))}
                          </ul>
                        )
                      }
                    </Deferred>
                  </Card>
                </div>
              </div>
            )
          }
        </Deferred>
      </div>
    </div>
  );
}
