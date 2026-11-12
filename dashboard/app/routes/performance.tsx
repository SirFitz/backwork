import type { LoaderFunctionArgs, MetaFunction } from "@remix-run/node";
import { defer } from "@remix-run/node";
import { Link, useLoaderData, useNavigate } from "@remix-run/react";
import type { ReactNode } from "react";
import { ArrowRight, Gauge } from "lucide-react";
import { Badge, Card, CardHead, Empty, ErrorNote, Sparkline } from "~/components/ui";
import { Deferred, RowsSkeleton } from "~/components/defer";
import { PALETTE } from "~/components/charts";
import { requireOrg } from "~/lib/auth/context.server";
import { tenantOf } from "~/lib/tenant.server";
import { safe } from "~/lib/config.server";
import {
  PERF_RANGES,
  PeerKind,
  connectionsTable,
  defaultService,
  isLabelValue,
  parseRange,
  routesTable,
  servicesTable,
  type ConnectionRow,
  type PerfRange,
  type RouteRow,
  type ServiceRow,
} from "~/lib/hops/metrics.server";
import { cn } from "~/lib/utils";

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

  // Each table is its own promise, so each loads, fails and shows its skeleton on its own.
  const servicesP = servicesTable(range, tenant);
  const selectedP: Promise<string | null> = requested
    ? Promise.resolve(requested)
    : servicesP.then(defaultService).catch(() => null);
  const services: Promise<Panel<{ rows: ServiceRow[]; selected: string | null }>> = safe(
    async () => ({ rows: await servicesP, selected: await selectedP }),
    { rows: [], selected: requested }
  );
  const routes: Promise<Panel<{ service: string | null; rows: RouteRow[] }>> = safe(async () => {
    const service = await selectedP;
    return { service, rows: service ? await routesTable(service, range, tenant) : [] };
  }, { service: requested, rows: [] });
  const connections: Promise<Panel<ConnectionRow[]>> = safe(async () => {
    const known = new Set((await servicesP.catch(() => [] as ServiceRow[])).map((s) => s.service));
    return connectionsTable(range, tenant, known, await selectedP);
  }, []);

  return defer({ range, requested, services, routes, connections });
}

// ---------------------------------------------------------------- formatting

/** Latency in seconds, as the frames write it: "0.6 ms", "38 ms", "2.4 s". */
function fmtLatency(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0) return "—";
  const ms = seconds * 1000;
  if (ms < 1) return `${ms.toFixed(1)} ms`;
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${seconds.toFixed(1)} s`;
}

function fmtRate(perSecond: number): string {
  if (perSecond > 0 && perSecond < 0.05) return "<0.1";
  return perSecond.toFixed(1);
}

function fmtShare(share: number, digits = 1): string {
  return `${(share * 100).toFixed(digits)}%`;
}

function errorTone(share: number): string {
  if (share >= 0.05) return "text-err";
  if (share >= 0.01) return "text-warn";
  return "";
}

/** Latency is toned only where a person waits on it: HTTP and RPC, from one second. */
function latencyTone(seconds: number | null, waitedOn: boolean): string {
  return waitedOn && seconds !== null && seconds >= 1 ? "text-warn" : "";
}

/** A stable colour per service name (the chart palette without the brand coral). */
function serviceColor(service: string): string {
  const colors = PALETTE.slice(0, PALETTE.length - 1);
  let h = 0;
  for (let i = 0; i < service.length; i++) h = (h * 31 + service.charCodeAt(i)) >>> 0;
  return colors[h % colors.length];
}

const REQUEST_RANGES: ReadonlySet<string> = new Set(["1h", "6h", "24h"]);

function requestsHref(route: RouteRow, range: PerfRange): string {
  const p = new URLSearchParams({ service: route.service, range: REQUEST_RANGES.has(range) ? range : "24h" });
  if (route.method) p.set("method", route.method);
  if (route.op) p.set("route", route.op);
  return `/requests?${p.toString()}`;
}

function perfHref(range: PerfRange, service: string | null): string {
  const p = new URLSearchParams({ range });
  if (service) p.set("service", service);
  return `/performance?${p.toString()}`;
}

// ---------------------------------------------------------------- table parts

const TH = "whitespace-nowrap border-b border-border px-4 py-2 text-left text-2xs font-medium uppercase tracking-wide text-faint";
const TD = "whitespace-nowrap border-b border-border px-4 py-2";
const NUM = "text-right font-mono text-[12.5px] tabular-nums";
/** Tighter cells for the two half-width tables (frame 5). */
const TIGHT = "px-[7px] first:pl-4 last:pr-4";

function Th({ children, num, className }: { children?: ReactNode; num?: boolean; className?: string }) {
  return <th className={cn(TH, num && "text-right", className)}>{children}</th>;
}

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

  return (
    <div className="space-y-4 animate-fade-in">
      <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-6">
        <div className="min-w-0">
          <h1 className="text-[22px] font-semibold tracking-tight">Performance</h1>
          <p className="mt-1 max-w-[70ch] text-[13.5px] text-muted">Request rate, errors and latency for every service that reports hops, by service, route and connection.</p>
        </div>
        <nav aria-label="Range" className="inline-flex h-9 shrink-0 items-center gap-0.5 self-start rounded-lg border border-border bg-surface p-[3px] text-xs text-muted">
          {PERF_RANGES.map((r) => (
            <Link
              key={r}
              to={perfHref(r, d.requested)}
              aria-current={r === range ? "true" : undefined}
              className={cn("rounded-[5px] px-[9px] py-[5px] font-medium", r === range ? "bg-surface-2 text-fg" : "hover:text-fg")}
            >
              {r}
            </Link>
          ))}
        </nav>
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
                  <div className="overflow-x-auto scroll-thin">
                    <table className="w-full border-collapse text-[13px]">
                      <thead>
                        <tr>
                          <Th>Service</Th>
                          <Th num>Req/s</Th>
                          <Th num>Errors</Th>
                          <Th num className="hidden md:table-cell">p50</Th>
                          <Th num>p95</Th>
                          <Th num className="hidden sm:table-cell">p99</Th>
                          <Th num>DB + cache</Th>
                          <Th num className="hidden lg:table-cell">p95 trend</Th>
                          <Th num className="hidden md:table-cell">In progress</Th>
                        </tr>
                      </thead>
                      <tbody>
                        {rows.map((s) => {
                          const color = serviceColor(s.service);
                          const waited = s.mainVia === "http" || s.mainVia === "rpc";
                          const on = s.service === selected;
                          return (
                            <tr
                              key={s.service}
                              onClick={() => navigate(perfHref(range, s.service), { preventScrollReset: true })}
                              aria-selected={on}
                              className={cn("cursor-pointer last:[&>td]:border-b-0 hover:bg-surface-2/50", on && "bg-surface-2 hover:bg-surface-2")}
                            >
                              <td className={TD}>
                                <Link to={perfHref(range, s.service)} preventScrollReset className="inline-flex items-center font-semibold" onClick={(e) => e.stopPropagation()}>
                                  <i className="mr-2 inline-block h-2 w-2 shrink-0 rounded-full" style={{ background: color }} />
                                  {s.service}
                                </Link>
                              </td>
                              <td className={cn(TD, NUM)}>{fmtRate(s.rate)}</td>
                              <td className={cn(TD, NUM, errorTone(s.errorShare))}>{fmtShare(s.errorShare)}</td>
                              <td className={cn(TD, NUM, "hidden md:table-cell")}>{fmtLatency(s.p50)}</td>
                              <td className={cn(TD, NUM)}>{fmtLatency(s.p95)}</td>
                              <td className={cn(TD, NUM, "hidden sm:table-cell", latencyTone(s.p99, waited))}>{fmtLatency(s.p99)}</td>
                              <td className={cn(TD, NUM)} title={s.storeCallsPerRequest !== null ? `${s.storeCallsPerRequest.toFixed(1)} data-store calls per request` : undefined}>
                                {s.storeShare === null ? "—" : fmtShare(s.storeShare, 0)}
                              </td>
                              <td className={cn(TD, "hidden text-right lg:table-cell")}>
                                <span className="inline-block align-middle"><Sparkline data={s.trend} color={color} width={96} height={22} /></span>
                              </td>
                              <td className={cn(TD, NUM, "hidden text-faint md:table-cell")}>{s.inProgress}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </PanelBody>
            </>
          )}
        </Deferred>
      </Card>

      <div className="grid items-start gap-4 lg:grid-cols-2">
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
                            <tr key={`${r.method} ${r.op}`} onClick={() => navigate(requestsHref(r, range))} className="cursor-pointer last:[&>td]:border-b-0 hover:bg-surface-2/50">
                              <td className={cn(TD, TIGHT, "font-mono text-[12.5px]")}>
                                <Link to={requestsHref(r, range)} onClick={(e) => e.stopPropagation()} title="Open these requests">
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
                            <tr key={`${c.service}>${c.peer}>${c.via ?? ""}`} className="last:[&>td]:border-b-0">
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
