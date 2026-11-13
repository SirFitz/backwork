import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { defer, json } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import { AlertTriangle, CheckCircle2, XCircle } from "lucide-react";
import { Link } from "@remix-run/react";
import { Card, CardHead, PageTitle } from "~/components/ui";
import { Deferred, RowsSkeleton } from "~/components/defer";
import { config } from "~/lib/config.server";
import * as vm from "~/lib/vm.server";
import { requireOrg } from "~/lib/auth/context.server";
import { tenantOf } from "~/lib/tenant.server";
import { cn } from "~/lib/utils";
import { DataControlsPanel } from "~/components/data-controls";
import { loadPlanView } from "~/lib/plans/view.server";
import { PausedBecause } from "~/lib/plans/limits";
import { assertSameOrigin } from "~/lib/auth/security.server";
import { safe } from "~/lib/config.server";
import {
  GRID_HEAD,
  applyControlChange,
  canManageControls,
  isControlIntent,
  loadControlsView,
  type ControlsView,
} from "~/lib/controls-view.server";

async function ping(url: string): Promise<boolean> {
  try {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), 5000);
    const r = await fetch(url, { signal: c.signal });
    clearTimeout(t);
    return r.ok;
  } catch {
    return false;
  }
}

export async function loader({ request }: LoaderFunctionArgs) {
  const ctx = await requireOrg(request);
  const isPlatform = tenantOf(ctx.org.id).platform;
  const url = new URL(request.url);
  const settingsKey = process.env.SETTINGS_KEY || "";
  const showToken = !settingsKey || url.searchParams.get("key") === settingsKey;

  const health = Promise.all([
    // /ready can flap 503; the labels API is a truer "is Loki serving" check
    ping(`${config.lokiUrl}/loki/api/v1/labels`),
    vm.targetsUp().then((t) => ({ ok: true, t })).catch(() => ({ ok: false, t: {} as Record<string, boolean> })),
  ]).then(([lokiUp, targets]) => ({
    loki: lokiUp,
    victoriametrics: targets.ok,
    vector: !!targets.t["vector"],
  }));

  // The same switches as on Projects, for the whole organisation (design 19.1).
  const controls: Promise<{ data: ControlsView | null; error: string | null }> = safe(
    () => loadControlsView({ orgId: ctx.org.id, projectId: null, services: async () => [], canManage: canManageControls(ctx) }),
    null
  );

  const plan = safe(() => loadPlanView(ctx.org.id), null);

  return defer({
    controls,
    plan,
    gridHeads: GRID_HEAD,
    publicUrl: config.publicUrl,
    isPlatform,
    // The legacy global token is platform-only; customer orgs use per-project
    // tokens from the Projects page (never expose the platform token to them).
    token: isPlatform && showToken ? config.ingestToken : "",
    tokenGated: isPlatform && !!settingsKey && !showToken,
    health,
    retention: { logs: "7 days hot (Loki)", metrics: "14 days (VictoriaMetrics)", hops: "30 days (Loki, hop records)" },
  });
}

export async function action({ request }: ActionFunctionArgs) {
  assertSameOrigin(request);
  const ctx = await requireOrg(request);
  const fd = await request.formData();
  const intent = String(fd.get("intent") ?? "");
  if (!isControlIntent(intent)) return json({ ok: false, error: "Unknown action." }, { status: 400 });
  // Organisation level only: a project id is never accepted here.
  fd.set("projectId", "");
  fd.set("service", "");
  return applyControlChange(request, ctx, fd, new Set<string>());
}

function HealthRow({ name, up, note }: { name: string; up: boolean; note: string }) {
  return (
    <li className="flex items-center gap-3 px-4 py-2.5">
      {up ? <CheckCircle2 className="h-4 w-4 text-ok" /> : <XCircle className="h-4 w-4 text-err" />}
      <span className="font-medium">{name}</span>
      <span className="text-2xs text-faint">{note}</span>
      <span className={cn("ml-auto text-2xs font-medium", up ? "text-ok" : "text-err")}>{up ? "reachable" : "unreachable"}</span>
    </li>
  );
}

function CodeBlock({ children }: { children: string }) {
  return (
    <pre className="overflow-x-auto scroll-thin rounded-lg border border-border bg-surface-2 px-3.5 py-3 font-mono text-2xs leading-relaxed text-fg/90">
      {children}
    </pre>
  );
}

export default function Settings() {
  const d = useLoaderData<typeof loader>();
  const tok = d.token || "<INGEST_TOKEN>";

  const agentCmd = `curl -fsSL ${d.publicUrl}/install.sh | sh -s -- \\
  --token ${tok} \\
  --name $(hostname)`;

  return (
    <div className="space-y-5 animate-fade-in">
      <PageTitle title="Settings" sub="Connect more sources, check backend health, and see retention. Everything backwork ingests is real host telemetry." />

      <Card>
        <CardHead title={d.isPlatform ? "Backend health" : "backwork platform status"} sub={d.isPlatform ? "the storage + collection layer" : "the shared backend — not a check of your own data flow"} />
        <Deferred resolve={d.health} fallback={<RowsSkeleton rows={3} />}>
          {(h) => (
            <ul className="divide-y divide-border">
              <HealthRow name="Loki" up={h.loki} note="log storage · LogQL" />
              <HealthRow name="VictoriaMetrics" up={h.victoriametrics} note="request figures · PromQL" />
              <HealthRow name="Vector" up={h.vector} note="log collector (scrape target)" />
            </ul>
          )}
        </Deferred>
      </Card>

      {d.isPlatform ? (
        <div className="grid grid-cols-[minmax(0,1fr)] gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <Card>
            <CardHead title="Ship logs from another server" sub="one command installs a Vector agent" />
            <div className="space-y-2 p-4">
              <CodeBlock>{agentCmd}</CodeBlock>
              <p className="text-2xs text-faint">Runs a Vector container that forwards the host's container logs and Correlator hop records to backwork, tagged with the host name. View them under Logs and Requests.</p>
            </div>
          </Card>
          <Card>
            <CardHead title="Trace requests" sub="hop records from Correlator, read from the logs" />
            <div className="space-y-2 p-4 text-[13px] text-muted">
              <p>Add Correlator to a service and turn hop records on. They are ordinary log lines, so the agent above ships them with the rest of the logs; no other endpoint or token is needed.</p>
              <p className="text-2xs text-faint">Requests and Performance fill in as hop records arrive.</p>
            </div>
          </Card>
        </div>
      ) : (
        <Card>
          <CardHead title="Connect a source" sub="ship logs and hop records from your own infrastructure" />
          <div className="p-4 text-[13px] text-muted">
            Create a <Link to="/projects" className="font-medium text-brand hover:underline">project</Link> to get an ingest token, then use the install command shown there. Your data is isolated to this organization.
          </div>
        </Card>
      )}

      <Deferred resolve={d.plan} fallback={null}>
        {(p) => (p.data ? <PlanCard plan={p.data} /> : null)}
      </Deferred>

      <Card>
        <CardHead title="Data controls" sub="what backwork collects for the whole organisation · off here is off for every project" />
        <div className="px-4 pb-4 pt-[18px] sm:pl-8 sm:pr-5">
          <Deferred resolve={d.controls} fallback={<RowsSkeleton rows={6} className="p-0" />}>
            {(panel) =>
              panel.error || !panel.data ? (
                <div className="text-2xs text-warn">data source unavailable — {(panel.error ?? "no data").slice(0, 180)}</div>
              ) : (
                <DataControlsPanel view={panel.data} heading="Collected from this organisation" gridHeads={d.gridHeads} />
              )
            }
          </Deferred>
        </div>
      </Card>

      <Card>
        <CardHead title="Retention" sub="how long data is kept" />
        <ul className="divide-y divide-border text-[13px]">
          <li className="flex items-center justify-between px-4 py-2.5"><span className="text-muted">Logs</span><span className="font-mono">{d.retention.logs}</span></li>
          <li className="flex items-center justify-between px-4 py-2.5"><span className="text-muted">Request figures</span><span className="font-mono">{d.retention.metrics}</span></li>
          <li className="flex items-center justify-between px-4 py-2.5"><span className="text-muted">Hop records</span><span className="font-mono">{d.retention.hops}</span></li>
        </ul>
      </Card>

      {d.isPlatform && d.token ? (
        <div className="rounded-xl border border-border bg-surface-2/40 px-4 py-3">
          <div className="flex items-start gap-2.5">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-faint" />
            <p className="text-[13px] text-muted">Keep the ingest token secret — anyone who has it can write telemetry into this organization. Rotate it if it leaks.</p>
          </div>
        </div>
      ) : null}
    </div>
  );
}


function fmtBytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(0)} MB`;
  return `${Math.round(n / 1024)} KB`;
}

function UsageBar({ label, used, limit, show }: { label: string; used: number; limit: number | null; show: (n: number) => string }) {
  const pct = limit ? Math.min(100, (used / limit) * 100) : 0;
  return (
    <li className="px-4 py-2.5">
      <div className="flex items-center justify-between text-[13px]">
        <span className="text-muted">{label}</span>
        <span className="font-mono">{show(used)}{limit ? ` of ${show(limit)}` : ""}</span>
      </div>
      {limit ? (
        <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-surface-2" role="progressbar" aria-label={label} aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100}>
          <div className={cn("h-full rounded-full", pct >= 100 ? "bg-err" : pct >= 80 ? "bg-warn" : "bg-brand")} style={{ width: `${pct}%` }} />
        </div>
      ) : null}
    </li>
  );
}

function PlanCard({ plan }: { plan: import("~/lib/plans/view.server").PlanView }) {
  return (
    <Card>
      <CardHead title={`${plan.name} plan`} sub={`usage for ${plan.period} (UTC)`} />
      {plan.paused ? (
        <div className="border-b border-border bg-surface-2 px-4 py-2.5 text-[13px] text-err">
          Collection is paused: this month's {plan.paused === PausedBecause.Requests ? "request" : "storage"} limit is reached. It resumes on the 1st (UTC).
        </div>
      ) : null}
      <ul className="divide-y divide-border">
        <UsageBar label="Traced requests" used={plan.requests.used} limit={plan.requests.limit} show={(n) => n.toLocaleString("en-GB")} />
        <UsageBar label="Stored data" used={plan.bytes.used} limit={plan.bytes.limit} show={fmtBytes} />
        {plan.hopDays !== null && plan.logDays !== null ? (
          <li className="flex items-center justify-between px-4 py-2.5 text-[13px]">
            <span className="text-muted">Kept for</span>
            <span className="font-mono">{plan.hopDays} days (requests) · {plan.logDays} days (logs)</span>
          </li>
        ) : null}
      </ul>
    </Card>
  );
}
