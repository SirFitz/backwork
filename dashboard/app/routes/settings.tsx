import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { defer, json } from "@remix-run/node";
import { Link, useLoaderData } from "@remix-run/react";
import { ArrowRight } from "lucide-react";
import { Card, CardHead, PageTitle } from "~/components/ui";
import { Deferred, RowsSkeleton } from "~/components/defer";
import { config, safe } from "~/lib/config.server";
import { hasRole, requireOrg } from "~/lib/auth/context.server";
import { logAudit } from "~/lib/audit.server";
import { PinAudit, loadPinSettings, pinUsage, savePinSettings } from "~/lib/pins.server";
import { AUTO_PINS_INTENT, AutoPinCard, type AutoPinView } from "~/components/insights/auto-pin-card";
import { tenantOf } from "~/lib/tenant.server";
import { cn } from "~/lib/utils";
import { DataControlsPanel, type SwitchGroup } from "~/components/data-controls";
import { loadPlanView, type PlanView } from "~/lib/plans/view.server";
import { assertSameOrigin } from "~/lib/auth/security.server";
import { Feature } from "~/lib/controls.server";
import {
  GRID_HEAD,
  applyControlChange,
  canManageControls,
  isControlIntent,
  loadControlsView,
  type ControlsView,
} from "~/lib/controls-view.server";

/** How long data is kept when the plan does not say otherwise. */
const DEFAULT_KEPT_DAYS = { logs: 7, requests: 30, figures: 14 } as const;

/** What the switches are grouped under: what is stored, and the detail kept inside each request. */
const SWITCH_GROUPS: readonly SwitchGroup[] = [
  { title: "Stored", features: [Feature.Logs, Feature.Hops, Feature.Stores, Feature.Metrics] },
  { title: "Detail inside each request", features: [Feature.NamedFields, Feature.Statements, Feature.Paths, Feature.LinkedIds] },
];

export async function loader({ request }: LoaderFunctionArgs) {
  const ctx = await requireOrg(request);
  const isPlatform = tenantOf(ctx.org.id).platform;
  const url = new URL(request.url);
  const settingsKey = process.env.SETTINGS_KEY || "";
  const showToken = !settingsKey || url.searchParams.get("key") === settingsKey;

  // The same switches as on Projects, for the whole organisation (design 19.1).
  const controls: Promise<{ data: ControlsView | null; error: string | null }> = safe(
    () => loadControlsView({ orgId: ctx.org.id, projectId: null, services: async () => [], canManage: canManageControls(ctx) }),
    null
  );

  const plan = safe(() => loadPlanView(ctx.org.id), null);
  // Automatic pins (BAC-78): switches and how many pins the plan allows.
  const pins: Promise<{ data: AutoPinView | null; error: string | null }> = safe(async () => {
    const [settings, usage] = await Promise.all([loadPinSettings(ctx.org.id), pinUsage(ctx.org.id)]);
    return { settings, count: usage.count, limit: usage.limit, canManage: hasRole(ctx.role, "admin") };
  }, null);

  return defer({
    controls,
    plan,
    pins,
    gridHeads: GRID_HEAD,
    groups: SWITCH_GROUPS,
    publicUrl: config.publicUrl,
    isPlatform,
    // The legacy global token is platform-only; customer orgs use per-project
    // tokens from the Projects page (never expose the platform token to them).
    token: isPlatform && showToken ? config.ingestToken : "",
  });
}

export async function action({ request }: ActionFunctionArgs) {
  assertSameOrigin(request);
  const ctx = await requireOrg(request);
  const fd = await request.formData();
  const intent = String(fd.get("intent") ?? "");
  if (intent === AUTO_PINS_INTENT) {
    if (!hasRole(ctx.role, "admin")) return json({ ok: false, error: "Only an admin can change automatic pins." }, { status: 403 });
    const which = String(fd.get("which") ?? "");
    if (which !== "slow" && which !== "failed") return json({ ok: false, error: "Unknown switch." }, { status: 400 });
    const current = await loadPinSettings(ctx.org.id);
    const next = { ...current, [which]: fd.get("on") === "1" };
    await savePinSettings(ctx.org.id, ctx.user.id, next);
    void logAudit({ request, orgId: ctx.org.id, actorUserId: ctx.user.id, action: PinAudit.Settings, target: next });
    return json({ ok: true });
  }
  if (!isControlIntent(intent)) return json({ ok: false, error: "Unknown action." }, { status: 400 });
  // Organisation level only: a project id is never accepted here.
  fd.set("projectId", "");
  fd.set("service", "");
  return applyControlChange(request, ctx, fd, new Set<string>());
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

  return (
    <div className="space-y-5 animate-fade-in">
      <PageTitle title="Settings" sub="Your plan, what backwork collects and how long it keeps it." />

      <Deferred resolve={d.plan} fallback={null}>
        {(p) => (p.data ? <PlanCard plan={p.data} /> : null)}
      </Deferred>

      <Card>
        <CardHead title="What backwork collects" sub="for the whole organisation · off here is off for every project" />
        <div className="px-4 pb-4 pt-[18px] sm:pl-8 sm:pr-5">
          <Deferred resolve={d.controls} fallback={<RowsSkeleton rows={6} className="p-0" />}>
            {(panel) =>
              panel.error || !panel.data ? (
                <div className="text-2xs text-warn">These settings could not be loaded just now. Reload the page to try again.</div>
              ) : (
                <DataControlsPanel view={panel.data} heading="Collected from this organisation" gridHeads={d.gridHeads} groups={d.groups} />
              )
            }
          </Deferred>
        </div>
      </Card>

      <Deferred resolve={d.plan} fallback={<KeptCard plan={null} />}>
        {(p) => <KeptCard plan={p.data} />}
      </Deferred>

      <Deferred resolve={d.pins} fallback={<Card><CardHead title="Pinned requests" /><RowsSkeleton rows={2} /></Card>}>
        {(p) => (p.data ? <AutoPinCard view={p.data} /> : <Card><CardHead title="Pinned requests" /><div className="border-t border-border px-4 py-2.5 text-2xs text-warn">These settings could not be loaded just now. Reload the page to try again.</div></Card>)}
      </Deferred>

      <Card>
        <CardHead
          className="border-b-0"
          title="Add a service"
          sub="each project has its own install command"
          right={
            <Link to="/projects" className="inline-flex items-center gap-1 text-[13px] text-brand hover:underline">
              Projects <ArrowRight className="h-3.5 w-3.5" />
            </Link>
          }
        />
        {d.isPlatform ? (
          <details className="group border-t border-border">
            <summary className="cursor-pointer list-none px-4 py-2.5 text-[13px] text-muted hover:text-fg">
              Install on another server with the organisation token
            </summary>
            <div className="space-y-2 px-4 pb-4">
              <CodeBlock>{`curl -fsSL ${d.publicUrl}/install.sh | sh -s -- \\
  --token ${d.token || "<INGEST_TOKEN>"} \\
  --name $(hostname)`}</CodeBlock>
              <p className="text-2xs text-faint">
                Installs the backwork agent, which sends that server's container logs and request records here, tagged with the host name. Keep the token secret: anyone who has it can send data into this organisation.
              </p>
            </div>
          </details>
        ) : null}
      </Card>
    </div>
  );
}

function fmtBytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(0)} MB`;
  return `${Math.round(n / 1024)} KB`;
}

function days(n: number): string {
  return `${n} ${n === 1 ? "day" : "days"}`;
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

function fmtSince(sec: number): string {
  const mins = Math.max(0, Math.round((Date.now() / 1000 - sec) / 60));
  if (mins < 90) return `${mins} min`;
  const hrs = mins / 60;
  return hrs < 48 ? `${hrs.toFixed(1)} hours` : `${Math.round(hrs / 24)} days`;
}

function PlanCard({ plan }: { plan: PlanView }) {
  return (
    <Card>
      <CardHead
        title={`${plan.name} plan`}
        sub={plan.rolling ? "keeps your newest requests and data; the oldest are dropped as new ones arrive" : "what this plan includes"}
        right={
          <span className="flex items-center gap-3 text-[13px]">
            <Link to="/usage" className="text-brand hover:underline">Usage</Link>
            <Link to="/billing" className="text-brand hover:underline">Billing</Link>
          </span>
        }
      />
      {plan.rolling ? (
        <ul className="divide-y divide-border">
          <UsageBar label="Traced requests held" used={plan.requests.held} limit={plan.requests.cap} show={(n) => n.toLocaleString("en-GB")} />
          <UsageBar label="Stored data held" used={plan.bytes.held} limit={plan.bytes.cap} show={fmtBytes} />
          {plan.since !== null ? (
            <li className="flex items-center justify-between px-4 py-2.5 text-[13px]">
              <span className="text-muted">Oldest request held</span>
              <span className="font-mono">{fmtSince(plan.since)} ago</span>
            </li>
          ) : null}
        </ul>
      ) : (
        <p className="border-t border-border px-4 py-2.5 text-[13px] text-muted">Nothing is dropped early on this plan; data is kept for the periods below.</p>
      )}
    </Card>
  );
}

/** How long each kind of data is kept: the plan's figure where it sets one, otherwise the standard. */
function KeptCard({ plan }: { plan: PlanView | null }) {
  const rows: { label: string; kept: number }[] = [
    { label: "Log lines", kept: plan?.logDays ?? DEFAULT_KEPT_DAYS.logs },
    { label: "Hop records", kept: plan?.hopDays ?? DEFAULT_KEPT_DAYS.requests },
    { label: "Performance figures", kept: DEFAULT_KEPT_DAYS.figures },
  ];
  return (
    <Card>
      <CardHead title="How long data is kept" sub={plan ? `set by your ${plan.name} plan` : "after this, it is deleted"} />
      <ul className="divide-y divide-border text-[13px]">
        {rows.map((r) => (
          <li key={r.label} className="flex items-center justify-between px-4 py-2.5">
            <span className="text-muted">{r.label}</span>
            <span className="font-mono">{days(r.kept)}</span>
          </li>
        ))}
      </ul>
    </Card>
  );
}
