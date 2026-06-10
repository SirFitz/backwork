import type { LoaderFunctionArgs } from "@remix-run/node";
import { defer } from "@remix-run/node";
import { Link, useLoaderData } from "@remix-run/react";
import { Activity, CheckCircle2, HeartPulse, MemoryStick, Power, RotateCcw } from "lucide-react";
import { Badge, Card, CardHead, Empty, PageTitle, Skeleton } from "~/components/ui";
import { Deferred, RowsSkeleton } from "~/components/defer";
import * as analysis from "~/lib/analysis.server";
import * as loki from "~/lib/loki.server";
import { cached } from "~/lib/cache.server";
import { requireOrg } from "~/lib/auth/context.server";
import { tenantOf } from "~/lib/tenant.server";
import { cn, fmtClock, LEVEL_TEXT, timeAgo } from "~/lib/utils";

const ICON: Record<string, any> = { oom: MemoryStick, unhealthy: HeartPulse, stopped: Power, restart: RotateCcw, error_spike: Activity, crash: Power };

export async function loader({ request }: LoaderFunctionArgs) {
  const ctx = await requireOrg(request);
  const t = tenantOf(ctx.org.id);
  const end = Date.now();
  const start = end - 6 * 3600 * 1000;
  return defer({
    isPlatform: t.platform,
    incidents: analysis.getIncidents(t),
    errors: cached(`inc:errors:${t.orgId}`, 8000, () => loki.queryRange('{level="error"}', { start, end, limit: 120 }, t)),
  });
}

function StatCard({ label, value, tone }: { label: string; value: number; tone?: string }) {
  return (
    <Card className="px-4 py-3.5">
      <div className="text-2xs uppercase tracking-wide text-faint">{label}</div>
      <div className={cn("mt-1 font-mono text-2xl font-semibold tabular-nums", tone)}>{value}</div>
    </Card>
  );
}

export default function Incidents() {
  const d = useLoaderData<typeof loader>();

  return (
    <div className="space-y-5 animate-fade-in">
      <PageTitle title="Incidents" sub={d.isPlatform ? "Crashes, OOM kills, failing healthchecks, restart loops and error spikes, detected automatically from container state, metrics and logs." : "Error spikes detected from your logs, plus OOM/restart signals when you ship container metrics. Crash/healthcheck detection needs the host agent."} />

      <Deferred resolve={d.incidents} fallback={<div className="grid grid-cols-3 gap-3">{Array.from({ length: 3 }).map((_, i) => <Card key={i} className="px-4 py-3.5"><Skeleton className="h-2.5 w-16" /><Skeleton className="mt-2 h-6 w-10" /></Card>)}</div>}>
        {(incidents) => {
          const critical = incidents.filter((i) => i.severity === "critical").length;
          return (
            <div className="grid grid-cols-3 gap-3">
              <StatCard label="Open incidents" value={incidents.length} />
              <StatCard label="Critical" value={critical} tone={critical > 0 ? "text-err" : "text-ok"} />
              <StatCard label="Warning" value={incidents.length - critical} tone={incidents.length - critical > 0 ? "text-warn" : "text-muted"} />
            </div>
          );
        }}
      </Deferred>

      <Card>
        <CardHead title="Open incidents" sub={d.isPlatform ? "derived from live container state, cAdvisor and logs" : "derived from your logs (and metrics, if shipped)"} />
        <Deferred resolve={d.incidents} fallback={<RowsSkeleton rows={5} />}>
          {(incidents) =>
            incidents.length === 0 ? (
              <div className="flex items-center gap-3 px-4 py-10">
                <CheckCircle2 className="h-5 w-5 text-ok" />
                <div>
                  <p className="text-sm font-medium">No open incidents</p>
                  <p className="text-[13px] text-muted">No crashes, OOM kills, failing healthchecks or error spikes right now.</p>
                </div>
              </div>
            ) : (
              <ul className="divide-y divide-border">
                {incidents.map((i) => {
                  const Icon = ICON[i.type] || Activity;
                  return (
                    <li key={i.id} className="flex items-start gap-3 px-4 py-3">
                      <span className={cn("mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-lg", i.severity === "critical" ? "bg-err/10 text-err" : "bg-warn/10 text-warn")}><Icon className="h-4 w-4" /></span>
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-[13.5px] font-medium">{i.title}</span>
                          <Badge tone={i.severity === "critical" ? "err" : "warn"}>{i.severity}</Badge>
                          <Badge tone="neutral">{i.type.replace("_", " ")}</Badge>
                        </div>
                        <p className="mt-0.5 text-[13px] text-muted">{i.detail}</p>
                      </div>
                      <div className="shrink-0 text-right">
                        <div className="text-2xs text-faint">{timeAgo(i.ts)}</div>
                        <Link to={`/logs?service=${encodeURIComponent(i.service)}&level=error`} className="text-2xs font-medium text-brand hover:underline">view logs</Link>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )
          }
        </Deferred>
      </Card>

      <Card>
        <CardHead title="Recent errors" sub="error-level log lines across all services, 6h" right={<Link to="/logs?level=error" className="text-2xs font-medium text-brand hover:underline">Open in Logs</Link>} />
        <Deferred resolve={d.errors} fallback={<RowsSkeleton rows={8} />}>
          {(errors) =>
            errors.length === 0 ? (
              <Empty title="No errors logged">Nothing at error level in the last 6 hours.</Empty>
            ) : (
              <div className="max-h-[46vh] overflow-auto scroll-thin font-mono text-[12.5px] leading-[1.7]">
                {errors.map((e, i) => (
                  <div key={i} className="flex gap-3 border-b border-border/40 px-4 py-1 hover:bg-surface-2/50">
                    <span className="shrink-0 tabular-nums text-faint">{fmtClock(e.ts)}</span>
                    <span className={cn("w-11 shrink-0 font-semibold uppercase", LEVEL_TEXT[e.level] || "text-faint")}>{e.level}</span>
                    <span className="w-40 shrink-0 truncate text-accent" title={e.service}>{e.service}</span>
                    <span className="min-w-0 flex-1 whitespace-pre-wrap break-words text-fg/90">{e.message}</span>
                  </div>
                ))}
              </div>
            )
          }
        </Deferred>
      </Card>
    </div>
  );
}
