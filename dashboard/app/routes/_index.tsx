import type { LoaderFunctionArgs, MetaFunction } from "@remix-run/node";
import { defer, json } from "@remix-run/node";
import { Link, useLoaderData } from "@remix-run/react";
import { lazy } from "react";
import { Activity, ArrowRight, Boxes, CheckCircle2, Gauge, TriangleAlert, Zap } from "lucide-react";
import { Badge, Card, CardHead, Empty, PageTitle, Skeleton, StatusDot, StatusPill } from "~/components/ui";
import { ChartSkeleton, Deferred, RowsSkeleton } from "~/components/defer";
// Lazy so recharts (~108 KB gz) isn't bundled into the dual `/` route chunk and
// shipped to logged-out marketing visitors; only loaded when the dashboard renders
// a chart (always inside a <Deferred> Suspense boundary). (PERF-1)
const AreaSeries = lazy(() => import("~/components/charts").then((m) => ({ default: m.AreaSeries })));
import * as analysis from "~/lib/analysis.server";
import * as apm from "~/lib/apm.server";
import * as vm from "~/lib/vm.server";
import * as loki from "~/lib/loki.server";
import { cached } from "~/lib/cache.server";
import { requireOrg, getUser } from "~/lib/auth/context.server";
import { tenantOf } from "~/lib/tenant.server";
import { cn, fmtBytes, fmtBytesRate, fmtCores, fmtMs, fmtNum, fmtPct, fmtRate } from "~/lib/utils";
import { MarketingLanding, seo, TAGLINE } from "~/components/marketing";

export const meta: MetaFunction = () =>
  seo({ title: "backwork — self-hosted logs, metrics & traces in one honest pane", description: TAGLINE, path: "/" });

export async function loader({ request }: LoaderFunctionArgs) {
  // logged-out visitors see the marketing landing; signed-in users get the dashboard
  if (!(await getUser(request))) return json({ marketing: true as const });
  const ctx = await requireOrg(request);
  const t = tenantOf(ctx.org.id);
  const end = Date.now();
  const start = end - 60 * 60 * 1000;
  const healthP = analysis.serviceHealth(t);
  const apmP = apm.getAPM(1, t);
  const incidentsP = analysis.getIncidents(t);
  const logVolP = cached(`ov:logvol:${t.orgId}`, 12000, () => loki.countOverTime('sum(count_over_time({service=~".+"}[1m]))', { start, end, step: "120s" }, t))
    .then((d) => d.map((p) => ({ t: p.t, v: p.v })))
    .catch(() => [] as { t: number; v: number }[]);
  // platform host CPU comes from cAdvisor; customer host CPU from node-exporter
  const cpuQuery = t.platform
    ? 'sum(rate(container_cpu_usage_seconds_total{name!=""}[5m]))'
    : 'sum(rate(node_cpu_seconds_total{mode!="idle"}[5m]))';
  const cpuTrendP = cached(`ov:cputrend:${t.orgId}`, 12000, () => vm.range(cpuQuery, { start, end, step: "120s" }, t))
    .then((s) => (s[0]?.points ?? []).map((p) => ({ t: p.t, v: p.v })))
    .catch(() => [] as { t: number; v: number }[]);

  return defer({
    cards: Promise.all([healthP, apmP, incidentsP]).then(([h, a, inc]) => {
      const host = analysis.hostSummary(h);
      return {
        up: host.servicesActive - host.servicesDown - host.servicesDegraded,
        host,
        apm: a.totals,
        incidents: inc.length,
        critical: inc.filter((i) => i.severity === "critical").length,
      };
    }),
    vitals: healthP.then((h) => analysis.hostSummary(h)),
    attention: healthP.then((h) => h.filter((s) => s.status === "down" || s.status === "degraded").slice(0, 8)),
    incidentsCount: incidentsP.then((i) => i.length),
    health: healthP.then((h) => h.slice(0, 14)),
    hostLoad: Promise.all([cpuTrendP, healthP]).then(([cpu, h]) => ({ cpuTrend: cpu, memBytes: analysis.hostSummary(h).memBytes })),
    logVol: logVolP,
  });
}

function SummaryCard({ icon: Icon, label, value, sub, tone, to }: { icon: any; label: string; value: string; sub?: string; tone?: string; to?: string }) {
  const inner = (
    <div className="flex h-full min-w-[160px] flex-1 items-center gap-3 px-4 py-3.5 transition-colors hover:bg-surface-2/40">
      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-surface-2 text-muted"><Icon className="h-4 w-4" /></span>
      <div className="min-w-0">
        <div className="text-2xs uppercase tracking-wide text-faint">{label}</div>
        <div className={cn("font-mono text-xl font-semibold leading-tight tabular-nums", tone)}>{value}</div>
        {sub ? <div className="truncate text-2xs text-faint">{sub}</div> : null}
      </div>
    </div>
  );
  return to ? <Link to={to} className="block min-w-[160px] flex-1">{inner}</Link> : inner;
}

function CardSkeleton() {
  return <div className="flex h-full min-w-[160px] flex-1 items-center gap-3 px-4 py-3.5"><Skeleton className="h-9 w-9 rounded-lg" /><div className="flex-1 space-y-1.5"><Skeleton className="h-2.5 w-16" /><Skeleton className="h-5 w-12" /></div></div>;
}
function Vital({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="px-4 py-3 first:pl-4">
      <div className="text-2xs uppercase tracking-wide text-faint">{label}</div>
      <div className={cn("mt-1 font-mono text-lg font-semibold tabular-nums", tone)}>{value}</div>
    </div>
  );
}

export default function Index() {
  const data = useLoaderData<typeof loader>();
  if ("marketing" in data) return <MarketingLanding />;
  const d = data;

  return (
    <div className="space-y-6 animate-fade-in">
      <PageTitle title="Overview" sub="What's healthy and what needs attention across every container on this host, in one place." />

      {/* summary strip */}
      <Deferred resolve={d.cards} fallback={<Card className="flex flex-wrap divide-x divide-border">{Array.from({ length: 5 }).map((_, i) => <CardSkeleton key={i} />)}</Card>}>
        {(c) => {
          const a = c.apm;
          const noServices = c.host.servicesActive === 0;
          return (
            <>
            <Card className="flex flex-wrap divide-x divide-y divide-border xl:divide-y-0">
              <SummaryCard icon={Boxes} label="Services up" value={noServices ? "—" : `${c.up}/${c.host.servicesActive}`} sub={noServices ? "no services reporting yet" : `${c.host.servicesDown} down · ${c.host.servicesDegraded} degraded · ${c.host.servicesStopped} stopped`} tone={noServices ? undefined : c.host.servicesDown > 0 ? "text-err" : c.host.servicesDegraded > 0 ? "text-warn" : "text-ok"} />
              <SummaryCard icon={Gauge} label="Request rate" value={a.services ? fmtRate(a.reqRate) : "—"} sub={a.services ? `${a.services} instrumented service${a.services > 1 ? "s" : ""}` : "instrument an app"} />
              <SummaryCard icon={TriangleAlert} label="Error rate" value={a.services ? fmtPct(a.errorRatePct) : "—"} sub="of traced requests" tone={a.errorRatePct >= 5 ? "text-err" : a.errorRatePct >= 1 ? "text-warn" : undefined} />
              <SummaryCard icon={Zap} label="Worst p95" value={a.services ? fmtMs(a.worstP95) : "—"} sub="tail latency" tone={a.worstP95 >= 1000 ? "text-err" : a.worstP95 >= 500 ? "text-warn" : undefined} />
              <SummaryCard icon={Activity} label="Active incidents" value={String(c.incidents)} sub={`${c.critical} critical`} tone={c.critical > 0 ? "text-err" : undefined} to="/incidents" />
            </Card>
            {noServices && !a.services ? (
              <div className="mt-3 flex flex-col gap-3 rounded-xl border border-brand/30 bg-brand/5 px-5 py-4 sm:flex-row sm:items-center">
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-semibold">No telemetry yet</div>
                  <p className="text-2xs text-muted">Create a project to get an ingest token, then ship logs &amp; traces from your app or server.</p>
                </div>
                <div className="flex shrink-0 gap-2">
                  <Link to="/projects" className="inline-flex h-9 items-center rounded-lg bg-brand px-3 text-[13px] font-medium text-brand-fg hover:opacity-90">Create a project</Link>
                  <Link to="/settings" className="inline-flex h-9 items-center rounded-lg border border-border px-3 text-[13px] font-medium hover:bg-surface-2">Install guide</Link>
                </div>
              </div>
            ) : null}
            </>
          );
        }}
      </Deferred>

      {/* container vitals strip */}
      <Card>
        <Deferred resolve={d.vitals} fallback={<div className="px-4 py-5"><Skeleton className="h-6 w-full" /></div>}>
          {(s) => (
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
          )}
        </Deferred>
      </Card>

      {/* needs attention + host load */}
      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHead title="Needs attention" sub="services not fully operational, worst first" right={<Link to="/incidents" className="text-2xs font-medium text-brand hover:underline">Incidents</Link>} />
          <Deferred resolve={d.attention} fallback={<RowsSkeleton rows={4} />}>
            {(list) =>
              list.length === 0 ? (
                <div className="flex items-center gap-3 px-4 py-8">
                  <CheckCircle2 className="h-5 w-5 text-ok" />
                  <div>
                    <p className="text-sm font-medium">All systems operational</p>
                    <p className="text-[13px] text-muted">No down or degraded services.</p>
                  </div>
                </div>
              ) : (
                <ul className="divide-y divide-border">
                  {list.map((h) => (
                    <li key={h.service} className="flex items-center gap-3 px-4 py-2.5">
                      <StatusDot status={h.status} pulse />
                      <Link to={`/logs?service=${encodeURIComponent(h.service)}`} className="font-medium hover:text-brand">{h.service}</Link>
                      {h.project ? <Badge>{h.project}</Badge> : null}
                      <span className="ml-auto truncate text-[13px] text-muted">{h.reasons[0] ?? "degraded"}</span>
                      <span className="font-mono text-2xs tabular-nums text-faint">{h.running}/{h.containers} up</span>
                    </li>
                  ))}
                </ul>
              )
            }
          </Deferred>
        </Card>

        <Card>
          <CardHead title="Host load" sub="CPU cores in use, 1h" />
          <Deferred resolve={d.hostLoad} fallback={<ChartSkeleton height={92} />}>
            {(hl) => (
              <>
                <div className="px-3 pb-2 pt-3"><AreaSeries points={hl.cpuTrend} color="oklch(0.55 0.17 290)" height={92} fmt={(n) => fmtCores(n)} /></div>
                <div className="border-t border-border px-4 py-3">
                  <div className="flex items-center justify-between text-[13px]">
                    <span className="text-muted">Memory in use</span>
                    <span className="font-mono font-medium tabular-nums">{fmtBytes(hl.memBytes)}</span>
                  </div>
                </div>
              </>
            )}
          </Deferred>
        </Card>
      </div>

      {/* services table */}
      <Card>
        <CardHead title="Services" sub="status, resources, throughput" right={<Link to="/containers" className="inline-flex items-center gap-1 text-2xs font-medium text-brand hover:underline">All containers <ArrowRight className="h-3 w-3" /></Link>} />
        <Deferred resolve={d.health} fallback={<RowsSkeleton rows={8} />}>
          {(health) =>
            health.length === 0 ? (
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
                    {health.map((h) => (
                      <tr key={h.service} className="border-b border-border/60 last:border-0 hover:bg-surface-2/50">
                        <td className="max-w-[260px] px-4 py-2.5"><Link to={`/logs?service=${encodeURIComponent(h.service)}`} className="truncate font-medium hover:text-brand">{h.service}</Link>{h.containers > 1 ? <span className="ml-2 text-2xs text-faint">×{h.containers}</span> : null}</td>
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
            )
          }
        </Deferred>
      </Card>

      {/* log volume */}
      <Card>
        <CardHead title="Log volume" sub="lines/min across all sources, 1h" right={<Link to="/logs" className="text-2xs font-medium text-brand hover:underline">Search logs</Link>} />
        <Deferred resolve={d.logVol} fallback={<ChartSkeleton height={150} />}>
          {(points) => <div className="p-3"><AreaSeries points={points} color="oklch(0.58 0.13 240)" height={150} fmt={(n) => fmtNum(n, 0)} /></div>}
        </Deferred>
      </Card>
    </div>
  );
}
