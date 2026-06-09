import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { Link, useLoaderData } from "@remix-run/react";
import { Activity, Flame, RotateCcw, TrendingDown, TrendingUp } from "lucide-react";
import { Badge, Card, CardHeader, Empty } from "~/components/ui";
import * as analysis from "~/lib/analysis.server";
import * as loki from "~/lib/loki.server";
import { safe } from "~/lib/config.server";
import { cn, fmtTime, LEVEL_COLOR, timeAgo } from "~/lib/utils";

const ICON = { crash: Flame, restart: RotateCcw, error_spike: Activity } as const;

export async function loader(_args: LoaderFunctionArgs) {
  const end = Date.now();
  const start = end - 6 * 3600 * 1000;
  const [incidents, anomalies, errors] = await Promise.all([
    safe(() => analysis.getIncidents(24), [] as analysis.Incident[]),
    safe(() => analysis.getAnomalies(), [] as analysis.Anomaly[]),
    safe(() => loki.queryRange('{level=~"error|fatal"}', { start, end, limit: 120 }), [] as loki.LogEntry[]),
  ]);
  return json({ incidents: incidents.data, anomalies: anomalies.data, errors: errors.data });
}

export default function Incidents() {
  const d = useLoaderData<typeof loader>();
  const critical = d.incidents.filter((i) => i.severity === "critical").length;

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-lg font-semibold">Incidents</h1>
        <p className="text-sm text-muted">Crashes, restarts and anomalies — detected automatically from logs and metrics, with the evidence attached.</p>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <Card className="px-4 py-3">
          <div className="text-[11px] uppercase tracking-wide text-muted">Open incidents</div>
          <div className="mt-1 font-mono text-2xl font-semibold">{d.incidents.length}</div>
        </Card>
        <Card className="px-4 py-3">
          <div className="text-[11px] uppercase tracking-wide text-muted">Critical</div>
          <div className={cn("mt-1 font-mono text-2xl font-semibold", critical > 0 ? "text-err" : "text-ok")}>{critical}</div>
        </Card>
        <Card className="px-4 py-3">
          <div className="text-[11px] uppercase tracking-wide text-muted">Anomalies</div>
          <div className={cn("mt-1 font-mono text-2xl font-semibold", d.anomalies.length > 0 ? "text-warn" : "text-ok")}>{d.anomalies.length}</div>
        </Card>
      </div>

      <Card>
        <CardHeader title="Detected incidents" subtitle="last 24h" />
        {d.incidents.length === 0 ? (
          <Empty>No incidents detected. Crash detection watches for OOM kills, restarts and error spikes.</Empty>
        ) : (
          <ul className="divide-y divide-border/50">
            {d.incidents.map((i) => {
              const Icon = ICON[i.type] || Activity;
              return (
                <li key={i.id} className="flex items-start gap-3 px-4 py-3">
                  <div className={cn("mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-md", i.severity === "critical" ? "bg-err/10 text-err" : "bg-warn/10 text-warn")}>
                    <Icon className="h-4 w-4" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium">{i.title}</span>
                      <Badge tone={i.severity === "critical" ? "err" : "warn"}>{i.severity}</Badge>
                      <Badge>{i.type.replace("_", " ")}</Badge>
                    </div>
                    <div className="mt-0.5 text-xs text-muted">{i.detail}</div>
                  </div>
                  <div className="shrink-0 text-right">
                    <div className="text-[11px] text-muted">{timeAgo(i.ts)}</div>
                    <Link to={`/logs?service=${i.service}&level=error`} className="text-xs text-brand hover:underline">view logs →</Link>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      {d.anomalies.length > 0 ? (
        <Card>
          <CardHeader title="Anomalies" subtitle="deviation from the trailing 1h baseline" />
          <ul className="divide-y divide-border/50">
            {d.anomalies.map((a, idx) => (
              <li key={idx} className="flex items-center gap-3 px-4 py-2.5">
                {a.deltaPct >= 0 ? <TrendingUp className="h-4 w-4 text-warn" /> : <TrendingDown className="h-4 w-4 text-info" />}
                <span className="text-sm font-medium">{a.service}</span>
                <span className="text-sm text-muted">{a.metric}</span>
                <span className="ml-auto font-mono text-sm tabular-nums">{a.deltaPct > 0 ? "+" : ""}{a.deltaPct.toFixed(0)}%</span>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      <Card>
        <CardHeader title="Error log stream" subtitle="correlated evidence · error + fatal · 6h" right={<Link to="/logs?level=error" className="text-xs text-brand hover:underline">Open in Logs →</Link>} />
        {d.errors.length === 0 ? (
          <Empty>No errors logged recently.</Empty>
        ) : (
          <div className="max-h-[45vh] overflow-auto scroll-thin font-mono text-[12.5px] leading-relaxed">
            {d.errors.map((e, i) => (
              <div key={i} className="flex gap-3 border-b border-border/30 px-4 py-1.5 hover:bg-panel-2/40">
                <span className="shrink-0 tabular-nums text-muted">{fmtTime(e.ts)}</span>
                <span className={cn("w-12 shrink-0 font-semibold uppercase", LEVEL_COLOR[e.level] || "text-muted")}>{e.level}</span>
                <span className="w-20 shrink-0 truncate text-accent">{e.service}</span>
                <span className="min-w-0 flex-1 whitespace-pre-wrap break-words text-fg/90">{e.message}</span>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
