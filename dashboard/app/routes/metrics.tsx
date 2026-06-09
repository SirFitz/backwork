import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { Link, useLoaderData } from "@remix-run/react";
import { Card, CardHead, Empty, PageTitle } from "~/components/ui";
import { PALETTE, TimeSeries } from "~/components/charts";
import * as vm from "~/lib/vm.server";
import { safe } from "~/lib/config.server";
import { fmtBytes, fmtBytesRate, fmtCores } from "~/lib/utils";

const KEY = "container_label_coolify_resourceName";

export async function loader(_args: LoaderFunctionArgs) {
  const end = Date.now();
  const start = end - 60 * 60 * 1000;
  const [cpuTop, memTop, netRx, netTx, cpuNow, memNow] = await Promise.all([
    safe(() => vm.range(`topk(7, sum by (${KEY})(rate(container_cpu_usage_seconds_total{name!=""}[5m])))`, { start, end, step: "120s" }), [] as vm.Series[]),
    safe(() => vm.range(`topk(7, sum by (${KEY})(container_memory_working_set_bytes{name!=""}))`, { start, end, step: "120s" }), [] as vm.Series[]),
    safe(() => vm.range(`sum(rate(container_network_receive_bytes_total{name!=""}[5m]))`, { start, end, step: "120s" }), [] as vm.Series[]),
    safe(() => vm.range(`sum(rate(container_network_transmit_bytes_total{name!=""}[5m]))`, { start, end, step: "120s" }), [] as vm.Series[]),
    safe(() => vm.instant(`topk(10, sum by (${KEY})(rate(container_cpu_usage_seconds_total{name!=""}[5m])))`), [] as { metric: Record<string, string>; value: number }[]),
    safe(() => vm.instant(`topk(10, sum by (${KEY})(container_memory_working_set_bytes{name!=""}))`), [] as { metric: Record<string, string>; value: number }[]),
  ]);

  const named = (rows: vm.Series[]) =>
    rows.map((r, i) => ({ name: r.metric[KEY] || "other", color: PALETTE[i % PALETTE.length], points: r.points }));

  return json({
    cpuTop: named(cpuTop.data),
    memTop: named(memTop.data),
    net: [
      { name: "rx", color: PALETTE[1], points: netRx.data[0]?.points ?? [] },
      { name: "tx", color: PALETTE[0], points: netTx.data[0]?.points ?? [] },
    ],
    cpuNow: cpuNow.data.map((r) => ({ name: r.metric[KEY] || "other", v: r.value })).sort((a, b) => b.v - a.v),
    memNow: memNow.data.map((r) => ({ name: r.metric[KEY] || "other", v: r.value })).sort((a, b) => b.v - a.v),
    empty: cpuTop.data.length === 0 && memTop.data.length === 0,
  });
}

function ConsumerTable({ title, rows, fmt, unit }: { title: string; rows: { name: string; v: number }[]; fmt: (n: number) => string; unit?: string }) {
  const max = rows[0]?.v || 1;
  return (
    <Card>
      <CardHead title={title} sub="top 10, last 5m" />
      {rows.length === 0 ? (
        <Empty title="No data" />
      ) : (
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

      {d.empty ? (
        <Card><Empty title="No metrics yet">cAdvisor populates within ~30s of the first scrape. If this persists, check that the cadvisor container is running.</Empty></Card>
      ) : (
        <>
          <div className="grid gap-4 xl:grid-cols-2">
            <Card>
              <CardHead title="CPU usage" sub="cores by service, top 7, 1h" />
              <div className="p-3"><TimeSeries series={d.cpuTop} height={210} fmt={(n) => fmtCores(n)} /></div>
            </Card>
            <Card>
              <CardHead title="Memory" sub="working set by service, top 7, 1h" />
              <div className="p-3"><TimeSeries series={d.memTop} height={210} fmt={(n) => fmtBytes(n)} /></div>
            </Card>
          </div>

          <Card>
            <CardHead title="Network throughput" sub="host total, receive vs transmit, 1h" />
            <div className="p-3"><TimeSeries series={d.net} height={170} fmt={(n) => fmtBytesRate(n)} /></div>
          </Card>

          <div className="grid gap-4 xl:grid-cols-2">
            <ConsumerTable title="Top CPU consumers" rows={d.cpuNow} fmt={(n) => fmtCores(n) + " cores"} />
            <ConsumerTable title="Top memory consumers" rows={d.memNow} fmt={(n) => fmtBytes(n)} />
          </div>
        </>
      )}
    </div>
  );
}
