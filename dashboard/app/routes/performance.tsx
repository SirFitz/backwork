import type { LoaderFunctionArgs, MetaFunction } from "@remix-run/node";
import { defer } from "@remix-run/node";
import { Link, useLoaderData, useNavigate } from "@remix-run/react";
import type { ReactNode } from "react";
import { ArrowRight, Check, Gauge } from "lucide-react";
import { Badge, Card, CardHead, Empty, ErrorNote } from "~/components/ui";
import { Deferred, RowsSkeleton } from "~/components/defer";
import { requireOrg } from "~/lib/auth/context.server";
import { tenantOf } from "~/lib/tenant.server";
import { safe } from "~/lib/config.server";
import { PERF_RANGES, PeerKind, type PerfRange } from "~/lib/hops/figures";
import {
  connectionsTable,
  defaultService,
  isLabelValue,
  parseRange,
  routesTable,
  servicesTable,
  type ConnectionRow,
  type RouteRow,
  type ServiceRow,
} from "~/lib/hops/metrics.server";
import { cn } from "~/lib/utils";
import { NUM, ServicesTable, TD, TIGHT, Th, errorTone, fmtLatency, fmtRate, fmtShare, latencyTone } from "~/components/services-table";
import { HEALTH_PARAM, HealthChecks, healthChecksFrom } from "~/lib/hops/health";

export const meta: MetaFunction = () => [{ title: "Performance · backwork" }];

interface Panel<T> {
  data: T;
  error: string | null;
}

export async function loader({ request }: LoaderFunctionArgs) {
  const ctx = await requireOrg(request);
  const tenant = tenantOf(ctx.org.id);
  const url = new URL(request.url);
  const range = parseRange(url.searchParams.get("range"));
  const asked = url.searchParams.get("service");
  const requested = asked && isLabelValue(asked) ? asked : null;
  const health = healthChecksFrom(url.searchParams.get(HEALTH_PARAM));

  // Each table is its own promise, so each loads, fails and shows its skeleton on its own.
  const servicesP = servicesTable(range, tenant, undefined, undefined, health);
  const selectedP: Promise<string | null> = requested
    ? Promise.resolve(requested)
    : servicesP.then(defaultService).catch(() => null);
  const services: Promise<Panel<{ rows: ServiceRow[]; selected: string | null }>> = safe(
    async () => ({ rows: await servicesP, selected: await selectedP }),
    { rows: [], selected: requested }
  );
  const routes: Promise<Panel<{ service: string | null; rows: RouteRow[] }>> = safe(async () => {
    const service = await selectedP;
    return { service, rows: service ? await routesTable(service, range, tenant, undefined, health) : [] };
  }, { service: requested, rows: [] });
  const connections: Promise<Panel<ConnectionRow[]>> = safe(async () => {
    const known = new Set((await servicesP.catch(() => [] as ServiceRow[])).map((s) => s.service));
    return connectionsTable(range, tenant, known, await selectedP);
  }, []);

  return defer({ range, requested, health, services, routes, connections });
}

// ---------------------------------------------------------------- formatting

const REQUEST_RANGES: ReadonlySet<string> = new Set(["1h", "6h", "24h"]);

function requestsHref(route: RouteRow, range: PerfRange, health: HealthChecks): string {
  const p = new URLSearchParams({ service: route.service, range: REQUEST_RANGES.has(range) ? range : "24h" });
  if (health === HealthChecks.Shown) p.set(HEALTH_PARAM, "1");
  if (route.method) p.set("method", route.method);
  if (route.op) p.set("route", route.op);
  return `/requests?${p.toString()}`;
}

function perfHref(range: PerfRange, service: string | null, health: HealthChecks): string {
  const p = new URLSearchParams({ range });
  if (service) p.set("service", service);
  if (health === HealthChecks.Shown) p.set(HEALTH_PARAM, "1");
  return `/performance?${p.toString()}`;
}

// ---------------------------------------------------------------- table parts

function PanelBody<T>({ panel, empty, children }: { panel: Panel<T>; empty: ReactNode | null; children: (data: T) => ReactNode }) {
  return (
    <>
      <ErrorNote error={panel.error} />
      {panel.error ? null : empty ?? children(panel.data)}
    </>
  );
}

// ---------------------------------------------------------------- page

export default function Performance() {
  const d = useLoaderData<typeof loader>();
  const navigate = useNavigate();
  const range = d.range as PerfRange;
  const health = d.health as HealthChecks;
  const otherHealth = health === HealthChecks.Shown ? HealthChecks.Hidden : HealthChecks.Shown;

  return (
    <div className="space-y-4 animate-fade-in">
      <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-6">
        <div className="min-w-0">
          <h1 className="text-[22px] font-semibold tracking-tight">Performance</h1>
          <p className="mt-1 max-w-[70ch] text-[13.5px] text-muted">Request rate, errors and latency for every service that reports hops, by service, route and connection.</p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2 self-start">
        <Link
          to={perfHref(range, d.requested, otherHealth)}
          preventScrollReset
          role="checkbox"
          aria-checked={health === HealthChecks.Shown}
          className="inline-flex h-9 items-center gap-2 rounded-lg border border-border bg-surface px-3 text-[13px] text-muted hover:text-fg"
        >
          <span aria-hidden className={cn("grid h-3.5 w-3.5 place-items-center rounded-[3px] border", health === HealthChecks.Shown ? "border-brand bg-brand text-brand-fg" : "border-border-strong")}>
            {health === HealthChecks.Shown ? <Check className="h-2.5 w-2.5" /> : null}
          </span>
          Show health checks
        </Link>
        <nav aria-label="Range" className="inline-flex h-9 shrink-0 items-center gap-0.5 self-start rounded-lg border border-border bg-surface p-[3px] text-xs text-muted">
          {PERF_RANGES.map((r) => (
            <Link
              key={r}
              to={perfHref(r, d.requested, health)}
              aria-current={r === range ? "true" : undefined}
              className={cn("rounded-[5px] px-[9px] py-[5px] font-medium", r === range ? "bg-surface-2 text-fg" : "hover:text-fg")}
            >
              {r}
            </Link>
          ))}
        </nav>
        </div>
      </div>

      <Card>
        <Deferred
          resolve={d.services}
          fallback={<><CardHead title="Services" sub={`inbound requests and jobs · last ${range}`} /><RowsSkeleton rows={5} /></>}
        >
          {(panel) => (
            <>
              <CardHead title="Services" sub={`inbound requests and jobs · last ${range}`} right={panel.error ? null : <Badge tone="neutral">{panel.data.rows.length}</Badge>} />
              <PanelBody
                panel={panel}
                empty={panel.data.rows.length ? null : (
                  <Empty icon={<Gauge className="h-5 w-5" />} title="No hop metrics in this range">
                    Services appear here once they run Correlator with hop records on, and their host runs the backwork collector or agent.
                  </Empty>
                )}
              >
                {({ rows, selected }) => (
                  <ServicesTable
                    rows={rows}
                    selected={selected}
                    hrefFor={(service) => perfHref(range, service, health)}
                    onOpen={(service) => navigate(perfHref(range, service, health), { preventScrollReset: true })}
                  />
                )}
              </PanelBody>
            </>
          )}
        </Deferred>
      </Card>

      <div className="grid grid-cols-[minmax(0,1fr)] items-start gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <Card>
          <Deferred resolve={d.routes} fallback={<><CardHead title="Routes" sub="slowest first" /><RowsSkeleton rows={4} /></>}>
            {(panel) => (
              <>
                <CardHead
                  title="Routes"
                  sub={`${panel.data.service ?? "no service chosen"} · slowest first`}
                  right={panel.error ? null : <Badge tone="neutral">{panel.data.rows.length}</Badge>}
                />
                <PanelBody
                  panel={panel}
                  empty={panel.data.rows.length ? null : (
                    <Empty title={panel.data.service ? "No routes in this range" : "No service to show"}>
                      {panel.data.service ? `${panel.data.service} reported no inbound hops in the last ${range}.` : "Pick a service above."}
                    </Empty>
                  )}
                >
                  {({ rows }) => (
                    <div className="overflow-x-auto scroll-thin">
                      <table className="w-full border-collapse text-[13px]">
                        <thead>
                          <tr>
                            <Th className={TIGHT}>Route</Th>
                            <Th num className={TIGHT}>Req/s</Th>
                            <Th num className={TIGHT}>Errors</Th>
                            <Th num className={TIGHT}>p95</Th>
                            <Th num className={cn(TIGHT, "hidden sm:table-cell")}>p99</Th>
                            <Th num className={TIGHT}>DB + cache</Th>
                          </tr>
                        </thead>
                        <tbody>
                          {rows.map((r) => (
                            <tr key={`${r.method} ${r.op}`} onClick={() => navigate(requestsHref(r, range, health))} className="cursor-pointer [&:last-child>td]:border-b-0 hover:bg-surface-2/50">
                              <td className={cn(TD, TIGHT, "font-mono text-[12.5px]")}>
                                <Link to={requestsHref(r, range, health)} onClick={(e) => e.stopPropagation()} title="Open these requests">
                                  {r.method ? <span className="font-medium text-faint">{r.method} </span> : null}
                                  {r.op || <span className="text-faint">(no route)</span>}
                                </Link>
                              </td>
                              <td className={cn(TD, TIGHT, NUM)}>{fmtRate(r.rate)}</td>
                              <td className={cn(TD, TIGHT, NUM, errorTone(r.errorShare))}>{fmtShare(r.errorShare)}</td>
                              <td className={cn(TD, TIGHT, NUM, latencyTone(r.p95, r.method !== ""))}>{fmtLatency(r.p95)}</td>
                              <td className={cn(TD, TIGHT, NUM, "hidden sm:table-cell")}>{fmtLatency(r.p99)}</td>
                              <td className={cn(TD, TIGHT, NUM)}>{r.storeShare === null ? "—" : fmtShare(r.storeShare, 0)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </PanelBody>
              </>
            )}
          </Deferred>
        </Card>

        <Card>
          <Deferred resolve={d.connections} fallback={<><CardHead title="Connections" sub={`calls between services and to data stores · last ${range}`} /><RowsSkeleton rows={6} /></>}>
            {(panel) => (
              <>
                <CardHead
                  title="Connections"
                  sub={`calls between services and to data stores · last ${range}`}
                  right={panel.error ? null : <Badge tone="neutral">{panel.data.length}</Badge>}
                />
                <PanelBody
                  panel={panel}
                  empty={panel.data.length ? null : <Empty title="No outbound calls in this range">Calls appear once a service makes HTTP, job, database or cache calls through a Correlator adapter.</Empty>}
                >
                  {(rows) => (
                    <div className="overflow-x-auto scroll-thin">
                      <table className="w-full border-collapse text-[13px]">
                        <thead>
                          <tr>
                            <Th className={TIGHT}>From, to</Th>
                            <Th num className={TIGHT}>Calls/s</Th>
                            <Th num className={TIGHT}>Errors</Th>
                            <Th num className={TIGHT}>p95</Th>
                          </tr>
                        </thead>
                        <tbody>
                          {rows.map((c) => (
                            <tr key={`${c.service}>${c.peer}>${c.via ?? ""}`} className="[&:last-child>td]:border-b-0">
                              <td className={cn(TD, TIGHT, "whitespace-normal")}>
                                <b className="font-semibold">{c.service}</b>
                                <div className="mt-0.5 flex min-w-0 flex-wrap items-center text-[12.5px] text-muted">
                                  <ArrowRight className="mr-[5px] h-[13px] w-[13px] shrink-0 text-faint" aria-label="to" />
                                  <span className={cn("break-all", c.peerKind === PeerKind.Service ? "font-medium text-fg" : "font-mono")}>{c.peer || "(no peer)"}</span>
                                  {c.peerKind !== PeerKind.Service ? <span className="ml-1 text-2xs text-faint">{PEER_TAG[c.peerKind]}</span> : null}
                                </div>
                              </td>
                              <td className={cn(TD, TIGHT, NUM)}>{fmtRate(c.rate)}</td>
                              <td className={cn(TD, TIGHT, NUM, errorTone(c.errorShare))}>{fmtShare(c.errorShare)}</td>
                              <td className={cn(TD, TIGHT, NUM)}>{fmtLatency(c.p95)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </PanelBody>
              </>
            )}
          </Deferred>
        </Card>
      </div>
    </div>
  );
}

const PEER_TAG: Record<PeerKind, string> = {
  [PeerKind.Service]: "",
  [PeerKind.Database]: "database",
  [PeerKind.Cache]: "cache",
  [PeerKind.Unmatched]: "not matched yet",
};
