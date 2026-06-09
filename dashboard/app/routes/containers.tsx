import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { Link, useLoaderData } from "@remix-run/react";
import { useMemo, useState } from "react";
import { ArrowDown, ArrowUp, Search } from "lucide-react";
import { Badge, Card, Empty, PageTitle, Sparkline, StatusPill } from "~/components/ui";
import * as analysis from "~/lib/analysis.server";
import * as vm from "~/lib/vm.server";
import { safe } from "~/lib/config.server";
import { cn, fmtBytes, fmtBytesRate, fmtCores, fmtNum } from "~/lib/utils";

const KEY = "container_label_coolify_resourceName";

export async function loader(_args: LoaderFunctionArgs) {
  const end = Date.now();
  const start = end - 30 * 60 * 1000;
  const [health, cpuR, memR] = await Promise.all([
    safe(() => analysis.serviceHealth(), [] as analysis.ServiceHealth[]),
    safe(() => vm.range(`sum by (${KEY})(rate(container_cpu_usage_seconds_total{name!=""}[5m]))`, { start, end, step: "120s" }), [] as vm.Series[]),
    safe(() => vm.range(`sum by (${KEY})(container_memory_working_set_bytes{name!=""})`, { start, end, step: "120s" }), [] as vm.Series[]),
  ]);
  const spark = (rows: vm.Series[]) => {
    const m: Record<string, number[]> = {};
    for (const r of rows) {
      const k = r.metric[KEY];
      if (k) m[k] = r.points.map((p) => p.v);
    }
    return m;
  };
  return json({ health: health.data, error: health.error, cpuSpark: spark(cpuR.data), memSpark: spark(memR.data) });
}

type SortKey = "service" | "status" | "cpuCores" | "memBytes" | "restarts" | "logRate" | "errorRate";
const STATUS_RANK = { down: 0, degraded: 1, up: 2 };

export default function Containers() {
  const d = useLoaderData<typeof loader>();
  const [q, setQ] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | "down" | "degraded" | "up">("all");
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: "logRate", dir: -1 });

  const rows = useMemo(() => {
    let r = d.health;
    if (q.trim()) {
      const t = q.trim().toLowerCase();
      r = r.filter((x) => x.service.toLowerCase().includes(t) || x.project.toLowerCase().includes(t));
    }
    if (statusFilter !== "all") r = r.filter((x) => x.status === statusFilter);
    const dir = sort.dir;
    return [...r].sort((a, b) => {
      if (sort.key === "service") return a.service.localeCompare(b.service) * dir;
      if (sort.key === "status") return (STATUS_RANK[a.status] - STATUS_RANK[b.status]) * dir;
      return ((a[sort.key] as number) - (b[sort.key] as number)) * dir;
    });
  }, [d.health, q, statusFilter, sort]);

  const toggleSort = (key: SortKey) =>
    setSort((s) => (s.key === key ? { key, dir: (s.dir * -1) as 1 | -1 } : { key, dir: key === "service" ? 1 : -1 }));

  const Th = ({ label, k, align = "right" }: { label: string; k: SortKey; align?: "left" | "right" }) => (
    <th className={cn("px-4 py-2 font-medium", align === "right" ? "text-right" : "text-left")}>
      <button onClick={() => toggleSort(k)} className={cn("inline-flex items-center gap-1 hover:text-fg", align === "right" && "flex-row-reverse")}>
        {label}
        {sort.key === k ? sort.dir === 1 ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" /> : null}
      </button>
    </th>
  );

  const counts = useMemo(() => ({
    all: d.health.length,
    down: d.health.filter((h) => h.status === "down").length,
    degraded: d.health.filter((h) => h.status === "degraded").length,
    up: d.health.filter((h) => h.status === "up").length,
  }), [d.health]);

  return (
    <div className="space-y-5 animate-fade-in">
      <PageTitle title="Containers" sub="Every service on the host, with live resource usage and log throughput. Click a column to sort, or filter by name or status." />

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[240px] flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-faint" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Filter by service or project"
            className="h-9 w-full rounded-lg border border-border bg-surface pl-9 pr-3 text-[13px] outline-none placeholder:text-faint focus:border-brand/40"
          />
        </div>
        <div className="inline-flex rounded-lg border border-border bg-surface p-0.5 text-2xs">
          {(["all", "down", "degraded", "up"] as const).map((k) => (
            <button
              key={k}
              onClick={() => setStatusFilter(k)}
              className={cn(
                "rounded-md px-2.5 py-1.5 font-medium capitalize transition-colors",
                statusFilter === k ? "bg-surface-2 text-fg" : "text-muted hover:text-fg"
              )}
            >
              {k} <span className="text-faint">{counts[k]}</span>
            </button>
          ))}
        </div>
      </div>

      <Card>
        {d.error ? (
          <Empty title="Metrics unavailable">{d.error}</Empty>
        ) : rows.length === 0 ? (
          <Empty title="No matching containers">Try clearing the filter.</Empty>
        ) : (
          <div className="overflow-x-auto scroll-thin">
            <table className="w-full text-[13px]">
              <thead>
                <tr className="border-b border-border text-2xs uppercase tracking-wide text-faint">
                  <Th label="Service" k="service" align="left" />
                  <Th label="Status" k="status" align="left" />
                  <th className="px-4 py-2 text-right font-medium">CPU</th>
                  <Th label="" k="cpuCores" />
                  <th className="px-4 py-2 text-right font-medium">Memory</th>
                  <Th label="" k="memBytes" />
                  <th className="px-4 py-2 text-right font-medium">Net I/O</th>
                  <Th label="Restarts" k="restarts" />
                  <Th label="Logs/s" k="logRate" />
                  <Th label="Err/s" k="errorRate" />
                </tr>
              </thead>
              <tbody>
                {rows.map((h) => (
                  <tr key={h.service} className="border-b border-border/60 last:border-0 hover:bg-surface-2/50">
                    <td className="max-w-[240px] px-4 py-2.5">
                      <Link to={`/logs?service=${encodeURIComponent(h.service)}`} className="block truncate font-medium hover:text-brand">{h.service}</Link>
                      <div className="flex items-center gap-1.5 text-2xs text-faint">
                        {h.project ? <span className="truncate">{h.project}</span> : null}
                        {h.containers > 1 ? <span>· {h.running}/{h.containers} up</span> : null}
                        {h.oom > 0 ? <Badge tone="err">OOM</Badge> : null}
                      </div>
                    </td>
                    <td className="px-4 py-2.5"><StatusPill status={h.status} /></td>
                    <td className="px-4 py-2.5 text-right font-mono tabular-nums text-muted">{fmtCores(h.cpuCores)}</td>
                    <td className="px-2 py-2.5 text-ok"><Sparkline data={d.cpuSpark[h.service] ?? []} color="oklch(0.6 0.13 150)" /></td>
                    <td className="px-4 py-2.5 text-right font-mono tabular-nums text-muted">{fmtBytes(h.memBytes)}</td>
                    <td className="px-2 py-2.5 text-info"><Sparkline data={d.memSpark[h.service] ?? []} color="oklch(0.58 0.13 240)" /></td>
                    <td className="whitespace-nowrap px-4 py-2.5 text-right font-mono text-2xs tabular-nums text-faint">{fmtBytesRate(h.netRxRate)} ↓<br />{fmtBytesRate(h.netTxRate)} ↑</td>
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
    </div>
  );
}
