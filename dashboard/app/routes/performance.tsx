import type { LoaderFunctionArgs, MetaFunction } from "@remix-run/node";
import { defer } from "@remix-run/node";
import { Link, useLoaderData, useNavigate } from "@remix-run/react";
import type { ReactNode } from "react";
import { ArrowRight, Check, Gauge } from "lucide-react";
import { Badge, Card, CardHead, Empty, ErrorNote, PageTitle } from "~/components/ui";
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
import { compareRoutes, compareServices, serviceTrend } from "~/lib/hops/compare.server";
import { canCompare, compareKey, type CompareRow } from "~/lib/hops/compare";
import { deploysBetween } from "~/lib/deploys.server";
import { CompareChip } from "~/components/insights/compare-chip";
import { TrendCard, type TrendPanel } from "~/components/insights/trend-card";

export const meta: MetaFunction = () => [{ title: "Performance · backwork" }];

interface Panel<T> {
  data: T;
  error: string | null;
}

/** `?compare=1` adds the "vs last week" column (BAC-73); ignored on ranges that cannot compare. */
const COMPARE_PARAM = "compare";

/** Rows of a compare result by key, or null when the comparison is off or failed. */
type CompareByKey = Record<string, CompareRow> | null;

function byKey(rows: CompareRow[]): Record<string, CompareRow> {
  const out: Record<string, CompareRow> = {};
  for (const r of rows) out[r.key] = r;
  return out;
}

/** The comparison never takes its table down with it: on failure the column says so. */
function compareOrNull(on: boolean, fn: () => Promise<CompareRow[]>): Promise<{ rows: CompareByKey; error: string | null }> {
  if (!on) return Promise.resolve({ rows: null, error: null });
  return fn().then(
    (rows) => ({ rows: byKey(rows), error: null }),
    (e: unknown) => ({ rows: null, error: e instanceof Error ? e.message : String(e) }),
  );
}

export async function loader({ request }: LoaderFunctionArgs) {
  const ctx = await requireOrg(request);
  const tenant = tenantOf(ctx.org.id);
  const url = new URL(request.url);
  const range = parseRange(url.searchParams.get("range"));
  const asked = url.searchParams.get("service");
  const requested = asked && isLabelValue(asked) ? asked : null;
  const health = healthChecksFrom(url.searchParams.get(HEALTH_PARAM));
  const compare = url.searchParams.get(COMPARE_PARAM) === "1" && canCompare(range);

  // Each table is its own promise, so each loads, fails and shows its skeleton on its own.
  const servicesP = servicesTable(range, tenant, undefined, undefined, health);
  const selectedP: Promise<string | null> = requested
    ? Promise.resolve(requested)
    : servicesP.then(defaultService).catch(() => null);
  const services: Promise<Panel<{ rows: ServiceRow[]; selected: string | null; compare: CompareByKey; compareError: string | null }>> = safe(
    async () => {
      const [rows, selected, cmp] = await Promise.all([servicesP, selectedP, compareOrNull(compare, () => compareServices(range, tenant, undefined, health))]);
      return { rows, selected, compare: cmp.rows, compareError: cmp.error };
    },
    { rows: [], selected: requested, compare: null, compareError: null }
  );
  const routes: Promise<Panel<{ service: string | null; rows: RouteRow[]; compare: CompareByKey; compareError: string | null }>> = safe(async () => {
    const service = await selectedP;
    if (!service) return { service, rows: [], compare: null, compareError: null };
    const [rows, cmp] = await Promise.all([
      routesTable(service, range, tenant, undefined, health),
      compareOrNull(compare, () => compareRoutes(service, range, tenant, undefined, health)),
    ]);
    return { service, rows, compare: cmp.rows, compareError: cmp.error };
  }, { service: requested, rows: [], compare: null, compareError: null });
  // The Trend card: p95 of the selected service, last week dashed, deploys marked (BAC-73).
  const trend: Promise<TrendPanel> = safe(async () => {
    const service = await selectedP;
    if (!service) return { service: null, range, now: [], lastWeek: null, deploys: [] };
    const t = await serviceTrend(service, range, tenant, undefined, undefined, health);
    const deploys = await deploysBetween(ctx.org.id, service, t.start, t.end);
    return { service, range, now: t.now, lastWeek: t.lastWeek, deploys };
  }, { service: requested, range, now: [], lastWeek: null, deploys: [] });
  const connections: Promise<Panel<ConnectionRow[]>> = safe(async () => {
    const known = new Set((await servicesP.catch(() => [] as ServiceRow[])).map((s) => s.service));
    return connectionsTable(range, tenant, known, await selectedP);
  }, []);

  return defer({ range, requested, health, compare, services, routes, trend, connections });
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

function perfHref(range: PerfRange, service: string | null, health: HealthChecks, compare = false): string {
  const p = new URLSearchParams({ range });
  if (service) p.set("service", service);
  if (health === HealthChecks.Shown) p.set(HEALTH_PARAM, "1");
  if (compare && canCompare(range)) p.set(COMPARE_PARAM, "1");
  return `/performance?${p.toString()}`;
}

/** A checkbox-styled link of the controls row (health checks, vs last week). */
function ToggleLink({ to, on, label, short, disabled, title }: { to: string; on: boolean; label: string; short: string; disabled?: boolean; title?: string }) {
  const box = (
    <span aria-hidden className={cn("grid h-3.5 w-3.5 place-items-center rounded-[3px] border", on ? "border-brand bg-brand text-brand-fg" : "border-border-strong")}>
      {on ? <Check className="h-2.5 w-2.5" /> : null}
    </span>
  );
  const cls = "inline-flex h-8 items-center gap-2 rounded-lg border border-border bg-surface px-2.5 text-[13px] text-muted";
  if (disabled) {
    return (
      <span role="checkbox" aria-checked={false} aria-disabled title={title} className={cn(cls, "cursor-not-allowed opacity-50")}>
        {box}
        <span className="hidden sm:inline">{label}</span>
        <span className="sm:hidden">{short}</span>
      </span>
    );
  }
  return (
    <Link to={to} preventScrollReset role="checkbox" aria-checked={on} title={title} className={cn(cls, "hover:text-fg")}>
      {box}
      <span className="hidden sm:inline">{label}</span>
      <span className="sm:hidden">{short}</span>
    </Link>
  );
}

/** The "vs last week" header and cells only exist while the comparison is on. */
function compareColumn<T>(compare: CompareByKey, keyOf: (row: T) => string): { head: string; cell: (row: T) => ReactNode } | undefined {
  if (!compare) return undefined;
  return { head: "vs last week", cell: (row: T) => <CompareChip row={compare[keyOf(row)]} /> };
}

function CompareNote({ error }: { error: string | null }) {
  if (!error) return null;
  return <p className="border-b border-warn/20 bg-warn/5 px-4 py-2 text-2xs text-warn">last week unavailable: {error.slice(0, 160)}</p>;
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
  const compare = d.compare;
  const compareOffered = canCompare(range);

  return (
    <div className="space-y-4 animate-fade-in">
      <PageTitle
        title="Performance"
        sub="Request rate, errors and latency for every service that reports hops, by service, route and connection."
        right={
          <>
            <ToggleLink to={perfHref(range, d.requested, otherHealth, compare)} on={health === HealthChecks.Shown} label="Show health checks" short="Health" />
            <ToggleLink
              to={perfHref(range, d.requested, health, !compare)}
              on={compare}
              label="vs last week"
              short="vs last wk"
              disabled={!compareOffered}
              title={compareOffered ? "Compare each service and route with the same hours last week" : "Not on 7d: metrics are kept for 14 days, too short to compare a whole week with the one before"}
            />
            {/* phone: the range as a select so title and controls stay one row */}
            <select
              aria-label="Range"
              value={range}
              onChange={(e) => navigate(perfHref(PERF_RANGES.find((r) => r === e.currentTarget.value) ?? range, d.requested, health, compare), { preventScrollReset: true })}
              className="h-8 rounded-lg border border-border bg-surface px-2 text-[13px] text-fg outline-none focus:border-brand/40 sm:hidden"
            >
              {PERF_RANGES.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
            <nav aria-label="Range" className="hidden h-8 shrink-0 items-center gap-0.5 rounded-lg border border-border bg-surface p-[3px] text-xs text-muted sm:inline-flex">
              {PERF_RANGES.map((r) => (
                <Link
                  key={r}
                  to={perfHref(r, d.requested, health, compare)}
                  aria-current={r === range ? "true" : undefined}
                  className={cn("rounded-[5px] px-[9px] py-1 font-medium", r === range ? "bg-surface-2 text-fg" : "hover:text-fg")}
                >
                  {r}
                </Link>
              ))}
            </nav>
          </>
        }
      />

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
                {({ rows, selected, compare: cmp, compareError }) => (
                  <>
                    <CompareNote error={compareError} />
                    <ServicesTable
                      rows={rows}
                      selected={selected}
                      hrefFor={(service) => perfHref(range, service, health, compare)}
                      onOpen={(service) => navigate(perfHref(range, service, health, compare), { preventScrollReset: true })}
                      extra={compareColumn<ServiceRow>(cmp, (r) => compareKey(r.service, null, null))}
                    />
                  </>
                )}
              </PanelBody>
            </>
          )}
        </Deferred>
      </Card>

      <TrendCard resolve={d.trend} range={range} compareOffered={compareOffered} />

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
                  {({ rows, compare: cmp, compareError }) => {
                    const col = compareColumn<RouteRow>(cmp, (r) => compareKey(r.service, r.method, r.op));
                    return (
                    <>
                    <CompareNote error={compareError} />
                    <div className="overflow-x-auto scroll-thin">
                      <table className="w-full border-collapse text-[13px]">
                        <thead>
                          <tr>
                            <Th className={TIGHT}>Route</Th>
                            <Th num className={TIGHT}>Req/s</Th>
                            <Th num className={TIGHT}>Errors</Th>
                            <Th num className={TIGHT}>p95</Th>
                            {col ? <Th num className={TIGHT}>{col.head}</Th> : null}
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
                              {col ? <td className={cn(TD, TIGHT, "text-right")}>{col.cell(r)}</td> : null}
                              <td className={cn(TD, TIGHT, NUM, "hidden sm:table-cell")}>{fmtLatency(r.p99)}</td>
                              <td className={cn(TD, TIGHT, NUM)}>{r.storeShare === null ? "—" : fmtShare(r.storeShare, 0)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    </>
                    );
                  }}
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
