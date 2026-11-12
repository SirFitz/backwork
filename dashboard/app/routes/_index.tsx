import type { LoaderFunctionArgs, MetaFunction } from "@remix-run/node";
import { defer, json } from "@remix-run/node";
import { Link, useLoaderData } from "@remix-run/react";
import { lazy, type ReactNode } from "react";
import { ArrowRight, CheckCircle2, CircleAlert, Network } from "lucide-react";
import { Badge, Card, CardHead, CardHeadText, ErrorNote, PageTitle, Skeleton } from "~/components/ui";
import { ChartSkeleton, Deferred, RowsSkeleton } from "~/components/defer";
import { Ago, Clock } from "~/components/time";
import { NUM, ServicesTable, TD, Th, fmtLatency, fmtShare } from "~/components/services-table";
// Lazy so recharts isn't bundled into the dual `/` route chunk shipped to logged-out visitors.
const AreaSeries = lazy(() => import("~/components/charts").then((m) => ({ default: m.AreaSeries })));
import { safe } from "~/lib/config.server";
import * as loki from "~/lib/loki.server";
import { cached } from "~/lib/cache.server";
import { requireOrg, getUser } from "~/lib/auth/context.server";
import { tenantOf } from "~/lib/tenant.server";
import { inboundServices, servicesTable, type ServiceRow } from "~/lib/hops/metrics.server";
import { PerfRange } from "~/lib/hops/figures";
import { hopRequestPage, type RequestListRow } from "~/lib/hops/requests.server";
import { serviceJumps, stalledRequests, unreceivedCalls } from "~/lib/hops/attention.server";
import { JumpKind, LIST_LIMIT, type RecordScan, type ServiceJump, type StalledRequest, type UnreceivedCall } from "~/lib/hops/attention";
import { cn, fmtMs, fmtNum } from "~/lib/utils";
import { seo, TAGLINE } from "~/components/marketing";
import { MarketingLanding } from "~/components/site/landing";

/** The public headline for visitors; the page's own title once signed in (BAC-41 row 20). */
export const meta: MetaFunction<typeof loader> = ({ data }) =>
  data && "marketing" in data
    ? seo({ title: "backwork — follow any request, from one ID", description: TAGLINE, path: "/" })
    : [{ title: "Overview · backwork" }];

interface Panel<T> {
  data: T;
  error: string | null;
}

/** How far back "latest failed requests" looks. */
const FAILED_WINDOW_MS = 24 * 3600_000;
const SERVICES_RANGE = PerfRange.H1;

const emptyScan = <T,>(): RecordScan<T> => ({ rows: [], total: 0, truncated: false });

export async function loader({ request }: LoaderFunctionArgs) {
  // Logged-out visitors see the marketing landing; signed-in users get the Overview.
  if (!(await getUser(request))) return json({ marketing: true as const });
  const ctx = await requireOrg(request);
  const t = tenantOf(ctx.org.id);
  const now = Date.now();

  // Every part is its own promise that always settles to { data, error }, so each section
  // shows its own skeleton, then its data or its own error, and never the others'.
  const reporting: Promise<Panel<number>> = safe(async () => (await inboundServices(t)).length, 0);
  const jumps: Promise<Panel<ServiceJump[]>> = safe(() => serviceJumps(t), []);
  const stalled: Promise<Panel<RecordScan<StalledRequest>>> = safe(() => stalledRequests(t, now), emptyScan<StalledRequest>());
  const unreceived: Promise<Panel<RecordScan<UnreceivedCall>>> = safe(() => unreceivedCalls(t, now), emptyScan<UnreceivedCall>());
  const services: Promise<Panel<ServiceRow[]>> = safe(() => servicesTable(SERVICES_RANGE, t), []);
  const failed: Promise<Panel<RequestListRow[]>> = safe(
    async () => (await hopRequestPage(t, { service: null, sinceMs: now - FAILED_WINDOW_MS, before: now, onlyFailed: true, limit: 200 })).rows.slice(0, LIST_LIMIT),
    []
  );
  const start = now - 3600_000;
  const logVolume: Promise<Panel<Array<{ t: number; v: number }>>> = safe(
    () =>
      cached(`ov:logvol:${t.platform ? "platform" : t.orgId}`, 12_000, () =>
        loki.countOverTime('sum(count_over_time({service=~".+", kind!="hop"}[1m]))', { start, end: now, step: "120s" }, t)
      ).then((d) => d.map((p) => ({ t: p.t, v: p.v }))),
    []
  );

  return defer({ reporting, jumps, stalled, unreceived, services, failed, logVolume });
}

// ---------------------------------------------------------------- wording

function jumpText(j: ServiceJump): { what: string; was: string } {
  if (j.kind === JumpKind.Errors) {
    return { what: `${fmtShare(j.now)} of requests failing`, was: j.before === null ? "no requests before" : `${fmtShare(j.before)} before` };
  }
  return { what: `slowest 1 in 20 take ${fmtLatency(j.now)}`, was: j.before === null ? "no requests before" : `${fmtLatency(j.before)} before` };
}

function routeOf(method: string | null, op: string | null): ReactNode {
  if (!method && !op) return <span className="text-faint">(no route)</span>;
  return (
    <>
      {method ? <span className="font-medium text-faint">{method} </span> : null}
      {op ?? ""}
    </>
  );
}

// ---------------------------------------------------------------- parts

function AllClear({ children }: { children: ReactNode }) {
  return (
    <p className="flex items-start gap-2 px-4 py-3 text-[13px] text-muted">
      <CheckCircle2 className="mt-px h-4 w-4 shrink-0 text-ok" aria-hidden />
      <span>{children}</span>
    </p>
  );
}

function SubHead({ title, sub, count }: { title: string; sub: string; count?: number }) {
  return (
    <div className="flex min-h-9 items-center justify-between gap-3 border-b border-border/60 bg-surface-2/40 px-4 py-1.5">
      <CardHeadText level={3} title={title} sub={sub} />
      {count ? <Badge tone="err">{count}</Badge> : null}
    </div>
  );
}

function TruncatedNote({ scan }: { scan: RecordScan<unknown> }) {
  if (!scan.truncated && scan.total <= scan.rows.length) return null;
  return (
    <p className="border-t border-border/60 px-4 py-2 text-2xs text-faint">
      {scan.total > scan.rows.length ? `Showing the newest ${scan.rows.length} of ${scan.total}. ` : ""}
      {scan.truncated ? "Busy period: only the newest records of the last 15 minutes were checked." : ""}
    </p>
  );
}

const OPEN = "font-sans text-2xs font-medium text-brand hover:underline";

function JumpsBody({ panel }: { panel: Panel<ServiceJump[]> }) {
  if (panel.error) return <ErrorNote error={panel.error} />;
  if (!panel.data.length) return <AllClear>No service is failing or slower than usual.</AllClear>;
  return (
    <div className="overflow-x-auto scroll-thin">
      <table className="w-full border-collapse text-[13px]">
        <thead>
          <tr>
            <Th>Service</Th>
            <Th>What changed</Th>
            <Th className="hidden sm:table-cell">Usually</Th>
            <Th num className="hidden sm:table-cell">Requests</Th>
            <Th />
          </tr>
        </thead>
        <tbody>
          {panel.data.map((j) => {
            const t = jumpText(j);
            return (
              <tr key={`${j.service}|${j.kind}`} className="[&:last-child>td]:border-b-0">
                <td className={cn(TD, "font-semibold")}>{j.service}</td>
                <td className={cn(TD, "whitespace-normal", j.kind === JumpKind.Errors ? "text-err" : "text-warn")}>{t.what}</td>
                <td className={cn(TD, "hidden text-muted sm:table-cell")}>{t.was}</td>
                <td className={cn(TD, NUM, "hidden sm:table-cell")}>{fmtNum(j.requests, 0)}</td>
                <td className={cn(TD, "text-right")}>
                  <Link to={`/performance?range=1h&service=${encodeURIComponent(j.service)}`} className={OPEN}>routes</Link>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function StalledBody({ panel }: { panel: Panel<RecordScan<StalledRequest>> }) {
  if (panel.error) return <ErrorNote error={panel.error} />;
  if (!panel.data.rows.length) return <AllClear>Every request and job that started finished.</AllClear>;
  return (
    <>
      <div className="overflow-x-auto scroll-thin">
        <table className="w-full border-collapse text-[13px]">
          <thead>
            <tr>
              <Th>Service</Th>
              <Th>Request</Th>
              <Th num>Started</Th>
              <Th />
            </tr>
          </thead>
          <tbody>
            {panel.data.rows.map((s) => (
              <tr key={`${s.traceId}|${s.startMs}|${s.service}`} className="[&:last-child>td]:border-b-0">
                <td className={cn(TD, "font-semibold")}>{s.service}</td>
                <td className={cn(TD, "max-w-[280px] truncate font-mono text-[12.5px]")}>{routeOf(s.method, s.op)}</td>
                <td className={cn(TD, NUM, "text-muted")}><Ago ts={s.startMs} /></td>
                <td className={cn(TD, "text-right")}><Link to={`/requests/${s.traceId}`} className={OPEN}>open</Link></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <TruncatedNote scan={panel.data} />
    </>
  );
}

function UnreceivedBody({ panel }: { panel: Panel<RecordScan<UnreceivedCall>> }) {
  if (panel.error) return <ErrorNote error={panel.error} />;
  if (!panel.data.rows.length) return <AllClear>Every call between services was received.</AllClear>;
  return (
    <>
      <div className="overflow-x-auto scroll-thin">
        <table className="w-full border-collapse text-[13px]">
          <thead>
            <tr>
              <Th>From, to</Th>
              <Th className="hidden sm:table-cell">Call</Th>
              <Th num>When</Th>
              <Th />
            </tr>
          </thead>
          <tbody>
            {panel.data.rows.map((c) => (
              <tr key={`${c.traceId}|${c.endMs}|${c.service}`} className="[&:last-child>td]:border-b-0">
                <td className={cn(TD, "whitespace-normal")}>
                  <b className="font-semibold">{c.service}</b>
                  <div className="mt-0.5 flex min-w-0 flex-wrap items-center text-[12.5px] text-muted">
                    <ArrowRight className="mr-[5px] h-[13px] w-[13px] shrink-0 text-faint" aria-label="to" />
                    <span className="break-all font-mono">{c.peer ?? "(no destination)"}</span>
                    {c.failed ? <span className="ml-1.5 text-2xs text-err">failed</span> : null}
                  </div>
                </td>
                <td className={cn(TD, "hidden max-w-[240px] truncate font-mono text-[12.5px] sm:table-cell")}>{routeOf(c.method, c.op)}</td>
                <td className={cn(TD, NUM, "text-muted")}><Ago ts={c.endMs} /></td>
                <td className={cn(TD, "text-right")}><Link to={`/requests/${c.traceId}`} className={OPEN}>open</Link></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <TruncatedNote scan={panel.data} />
    </>
  );
}

/** The three "needs attention" groups, in page order. */
const AttentionGroup = {
  Jumps: "jumps",
  Stalled: "stalled",
  Unreceived: "unreceived",
} as const;
type AttentionGroup = (typeof AttentionGroup)[keyof typeof AttentionGroup];

/** How each group is named when it has nothing in it, and what it checks (hover text). */
const CLEAR_TEXT: Record<AttentionGroup, { clear: string; checks: string }> = {
  [AttentionGroup.Jumps]: { clear: "nothing failing or slower than usual", checks: "Slower or failing more than usual, compared with the 3 hours before" },
  [AttentionGroup.Stalled]: { clear: "no stopped requests", checks: "Requests that started over a minute ago and never finished" },
  [AttentionGroup.Unreceived]: { clear: "no missing calls", checks: "Calls a service made to another that no service recorded arriving" },
};

function ClearLine({ groups, all }: { groups: AttentionGroup[]; all: boolean }) {
  return (
    <AllClear>
      {all ? "All clear in the last 15 minutes: " : "Also clear: "}
      {groups.map((g, i) => (
        <span key={g} title={CLEAR_TEXT[g].checks}>
          {CLEAR_TEXT[g].clear}
          {i < groups.length - 1 ? ", " : "."}
        </span>
      ))}
    </AllClear>
  );
}

/**
 * All clear: one line. Otherwise only the groups with something in them (or that failed to load),
 * each under a one-row header, then one line naming the groups that are clear (BAC-53).
 */
function AttentionBody({
  jumps,
  stalled,
  unreceived,
}: {
  jumps: Panel<ServiceJump[]>;
  stalled: Panel<RecordScan<StalledRequest>>;
  unreceived: Panel<RecordScan<UnreceivedCall>>;
}) {
  const isClear: Record<AttentionGroup, boolean> = {
    [AttentionGroup.Jumps]: !jumps.error && jumps.data.length === 0,
    [AttentionGroup.Stalled]: !stalled.error && stalled.data.rows.length === 0,
    [AttentionGroup.Unreceived]: !unreceived.error && unreceived.data.rows.length === 0,
  };
  const order: AttentionGroup[] = [AttentionGroup.Jumps, AttentionGroup.Stalled, AttentionGroup.Unreceived];
  const clear = order.filter((g) => isClear[g]);
  if (clear.length === order.length) return <ClearLine groups={clear} all />;
  return (
    <>
      {isClear[AttentionGroup.Jumps] ? null : (
        <section aria-label="Services slower or failing more than usual" className="border-b border-border last:border-b-0">
          <SubHead title="Slower or failing more than usual" sub="compared with the 3 hours before" />
          <JumpsBody panel={jumps} />
        </section>
      )}
      {isClear[AttentionGroup.Stalled] ? null : (
        <section aria-label="Requests that stopped" className="border-b border-border last:border-b-0">
          <SubHead title="Requests that stopped" sub="started over a minute ago and never finished" />
          <StalledBody panel={stalled} />
        </section>
      )}
      {isClear[AttentionGroup.Unreceived] ? null : (
        <section aria-label="Calls never received" className="border-b border-border last:border-b-0">
          <SubHead title="Calls never received" sub="a service called another and no service recorded the call arriving" />
          <UnreceivedBody panel={unreceived} />
        </section>
      )}
      {clear.length ? <ClearLine groups={clear} all={false} /> : null}
    </>
  );
}

function statusTone(s: number | null): string {
  if (s === null) return "text-muted";
  if (s >= 500) return "text-err";
  if (s >= 400) return "text-warn";
  return "text-muted";
}

// ---------------------------------------------------------------- page

export default function Index() {
  const data = useLoaderData<typeof loader>();
  if ("marketing" in data) return <MarketingLanding />;
  const d = data;

  return (
    <div className="space-y-4 animate-fade-in">
      <PageTitle title="Overview" sub="Is anything slow or failing right now, and where. From the requests your services report." />

      <Deferred resolve={d.reporting} fallback={null}>
        {(p) =>
          !p.error && p.data === 0 ? (
            <div className="flex flex-col gap-3 rounded-xl border border-brand/30 bg-brand/5 px-5 py-4 sm:flex-row sm:items-center">
              <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-surface text-muted"><Network className="h-4 w-4" /></span>
              <div className="min-w-0 flex-1">
                <div className="text-sm font-semibold">No service reports requests yet</div>
                <p className="text-2xs text-muted">Add Correlator to a service and run the backwork agent on its host. Its requests then appear here within a minute.</p>
              </div>
              <Link to="/projects" className="inline-flex h-9 shrink-0 items-center justify-center rounded-lg bg-brand px-3 text-[13px] font-medium text-brand-fg hover:opacity-90">Set up a project</Link>
            </div>
          ) : null
        }
      </Deferred>

      <Card>
        <CardHead
          title="Needs attention"
          sub="the last 15 minutes, health checks left out"
          right={
            <Deferred resolve={Promise.all([d.jumps, d.stalled, d.unreceived])} fallback={<Skeleton className="h-5 w-24" />}>
              {([j, s, u]) => {
                if (j.error || s.error || u.error) return <span className="text-2xs text-faint">partly unknown</span>;
                const n = j.data.length + s.data.total + u.data.total;
                return n === 0 ? (
                  <span className="inline-flex items-center gap-1 text-2xs font-medium text-ok"><CheckCircle2 className="h-3.5 w-3.5" />all clear</span>
                ) : (
                  <span className="inline-flex items-center gap-1 text-2xs font-medium text-err"><CircleAlert className="h-3.5 w-3.5" />{n} to look at</span>
                );
              }}
            </Deferred>
          }
        />
        <Deferred resolve={Promise.all([d.jumps, d.stalled, d.unreceived])} fallback={<RowsSkeleton rows={3} />}>
          {([j, s, u]) => <AttentionBody jumps={j} stalled={s} unreceived={u} />}
        </Deferred>
      </Card>

      <Card>
        <Deferred resolve={d.services} fallback={<><CardHead title="Services" sub="requests and jobs, last hour" /><RowsSkeleton rows={4} /></>}>
          {(p) => (
            <>
              <CardHead
                title="Services"
                sub="requests and jobs, last hour"
                right={<Link to="/performance?range=1h" className="inline-flex items-center gap-1 text-2xs font-medium text-brand hover:underline">Performance <ArrowRight className="h-3 w-3" /></Link>}
              />
              <ErrorNote error={p.error} />
              {p.error ? null : p.data.length === 0 ? (
                <p className="px-4 py-6 text-center text-[13px] text-muted">No requests in the last hour.</p>
              ) : (
                <ServicesTable rows={p.data} compact hrefFor={(s) => `/performance?range=1h&service=${encodeURIComponent(s)}`} />
              )}
            </>
          )}
        </Deferred>
      </Card>

      <Card>
        <CardHead
          title="Latest failed requests"
          sub="failed or answered with a server error, last 24 hours"
          right={<Link to="/requests?range=24h" className="inline-flex items-center gap-1 text-2xs font-medium text-brand hover:underline">All requests <ArrowRight className="h-3 w-3" /></Link>}
        />
        <Deferred resolve={d.failed} fallback={<RowsSkeleton rows={4} />}>
          {(p) =>
            p.error ? (
              <ErrorNote error={p.error} />
            ) : p.data.length === 0 ? (
              <AllClear>No request failed in the last 24 hours.</AllClear>
            ) : (
              <div className="overflow-x-auto scroll-thin">
                <table className="w-full border-collapse text-[13px]">
                  <thead>
                    <tr>
                      <Th>Time</Th>
                      <Th>Service</Th>
                      <Th className="hidden sm:table-cell">Request</Th>
                      <Th num>Status</Th>
                      <Th num className="hidden sm:table-cell">Took</Th>
                      <Th />
                    </tr>
                  </thead>
                  <tbody>
                    {p.data.map((r) => (
                      <tr key={`${r.traceID}|${r.service}|${r.startMs}`} className="[&:last-child>td]:border-b-0 hover:bg-surface-2/50">
                        <td className={cn(TD, NUM, "text-faint")}><Clock ts={r.startMs} seconds /></td>
                        <td className={cn(TD, "font-semibold")}>{r.service}</td>
                        <td className={cn(TD, "hidden max-w-[320px] truncate font-mono text-[12.5px] sm:table-cell")}>{routeOf(r.method, r.route)}</td>
                        <td className={cn(TD, NUM, "font-semibold", statusTone(r.status))}>{r.status ?? "failed"}</td>
                        <td className={cn(TD, NUM, "hidden text-muted sm:table-cell")}>{fmtMs(r.durationMs)}</td>
                        <td className={cn(TD, "text-right")}><Link to={`/requests/${r.traceID}`} className={OPEN}>open</Link></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )
          }
        </Deferred>
      </Card>

      <Card>
        <CardHead title="Log volume" sub="log lines per minute, last hour" right={<Link to="/logs" className="text-2xs font-medium text-brand hover:underline">Search logs</Link>} />
        <Deferred resolve={d.logVolume} fallback={<ChartSkeleton height={130} />}>
          {(p) => (
            <>
              <ErrorNote error={p.error} />
              {p.error ? null : <div className="p-3"><AreaSeries points={p.data} color="oklch(0.58 0.13 240)" height={130} fmt={(n) => fmtNum(n, 0)} /></div>}
            </>
          )}
        </Deferred>
      </Card>
    </div>
  );
}
