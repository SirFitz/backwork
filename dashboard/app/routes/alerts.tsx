import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { defer, json, redirect } from "@remix-run/node";
import { Form, useActionData, useFetcher, useLoaderData } from "@remix-run/react";
import { useEffect, useRef, useState } from "react";
import { ulid } from "ulid";
import { Check, Plus, Send, Trash2, X } from "lucide-react";
import { Badge, Card, CardHead, Empty, PageTitle } from "~/components/ui";
import { Deferred, RowsSkeleton } from "~/components/defer";
import { AlertFormFields, EMPTY_DRAFT, FIELD, draftForMetric, type RuleDraft } from "~/components/insights/alert-form-fields";
import * as alerts from "~/lib/alerts.server";
import { alertTargets, evaluate, evaluateRule } from "~/lib/alerts-eval.server";
import { clearState, forgetRule, loadStates, recentEvents, DELIVERED_OK, type StoredAlertState } from "~/lib/alert-state.server";
import * as channels from "~/lib/channels.server";
import { logAudit } from "~/lib/audit.server";
import { requireOrg, requireRole } from "~/lib/auth/context.server";
import { tenantOf } from "~/lib/tenant.server";
import { assertSameOrigin } from "~/lib/auth/security.server";
import { METRIC_META, isAlertMetric, ruleForMs, ruleFromDraft, ruleTarget, type AlertMetric, type RuleDraftInput } from "~/lib/alert-kinds";
import { RuleStatus, ruleStatus } from "~/lib/alert-decision";
import { isBreach, type AlertTargets } from "~/lib/alert-queries";
import { fmtCount, fmtRuleValue, previewLine } from "~/lib/alert-message";
import { cn } from "~/lib/utils";

/** "14 Nov 14:02 UTC", rendered on the server so the page hydrates the same text. */
function utcText(ms: number): string {
  const d = new Date(ms);
  const day = d.toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
  const time = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "UTC" });
  return `${day} ${time} UTC`;
}

interface HistoryView {
  id: string;
  kind: string;
  at: string;
  value: string | null;
  /** null until the sends finished */
  delivered: Array<{ name: string; ok: boolean; text: string }> | null;
}

/** One row of the Rules table, ready to render. */
interface RuleRowView {
  id: string;
  name: string;
  retired: string | null;
  enabled: boolean;
  channelIds: string[];
  target: string;
  condition: string;
  forMinutes: number;
  value: string | null;
  valueNote: string | null;
  status: RuleStatus;
  pendingSince: string | null;
  history: HistoryView[];
}

interface RulesData {
  rows: RuleRowView[];
  channels: channels.Channel[];
}

export async function loader({ request }: LoaderFunctionArgs) {
  const ctx = await requireOrg(request);
  const orgId = ctx.org.id;
  const t = tenantOf(orgId);
  const data = (async (): Promise<RulesData> => {
    const rules = await alerts.loadRules(orgId);
    const [states, stored, events, chans] = await Promise.all([
      evaluate(t, undefined, rules),
      loadStates(orgId).catch((): Map<string, StoredAlertState> => new Map()),
      recentEvents(orgId).catch(() => []),
      channels.loadChannels(orgId),
    ]);
    const names = new Map(chans.map((c) => [c.id, c.name]));
    const rows = states.map((s): RuleRowView => {
      const st = stored.get(s.id) ?? null;
      const metric: AlertMetric | null = isAlertMetric(s.metric) ? s.metric : null;
      const history = events
        .filter((e) => e.ruleId === s.id)
        .map((e): HistoryView => ({
          id: e.id,
          kind: e.kind,
          at: utcText(e.at),
          value: metric && e.value !== null ? fmtRuleValue(metric, e.value) : null,
          delivered: e.delivered === null ? null : Object.entries(e.delivered).map(([id, r]) => ({ name: names.get(id) ?? id, ok: r === DELIVERED_OK, text: r })),
        }));
      return {
        id: s.id,
        name: s.name,
        retired: s.retired ?? null,
        enabled: s.enabled,
        channelIds: s.channelIds,
        target: ruleTarget(s),
        condition: metric ? `${METRIC_META[metric].label} ${s.comparator} ${s.threshold}${METRIC_META[metric].unit}` : s.metric,
        forMinutes: Math.round(ruleForMs(s) / 60_000),
        value: metric && !s.noData ? fmtRuleValue(metric, s.value) : null,
        valueNote: s.requests !== undefined ? `${fmtCount(s.requests)} requests in the window` : s.query ? `${fmtCount(s.query.calls)} calls in the last hour` : null,
        status: ruleStatus({ retired: !!s.retired, enabled: s.enabled, noData: s.noData, breach: isBreach(s, s), stored: st, forMs: ruleForMs(s) }),
        pendingSince: st?.pendingSince != null ? utcText(st.pendingSince) : null,
        history,
      };
    });
    return { rows, channels: chans.map(channels.redact) };
  })().catch((): RulesData => ({ rows: [], channels: [] }));
  return defer({
    data,
    targets: alertTargets(t).catch((): AlertTargets => ({ routes: [], shapes: [] })),
    channelTypes: channels.CHANNEL_TYPES,
  });
}

function draftInput(fd: FormData): RuleDraftInput {
  const s = (k: string): string | null => {
    const v = fd.get(k);
    return typeof v === "string" ? v : null;
  };
  return {
    name: s("name"),
    metric: s("metric"),
    service: s("service"),
    comparator: s("comparator"),
    threshold: s("threshold"),
    channelIds: fd.getAll("channelIds").map(String),
    route: s("route"),
    window: s("window"),
    minRequests: s("minRequests"),
    shape: s("shape"),
    minCalls: s("minCalls"),
    forMinutes: s("forMinutes"),
  };
}

export async function action({ request }: ActionFunctionArgs) {
  assertSameOrigin(request);
  const ctx = await requireOrg(request);
  requireRole(ctx, "member"); // viewers are read-only (H6)
  const orgId = ctx.org.id;
  const fd = await request.formData();
  const intent = String(fd.get("intent"));
  const audit = (action: alerts.AlertAudit, target: Record<string, unknown>) => void logAudit({ request, orgId, actorUserId: ctx.user.id, action, target });

  // ---- channel intents ----
  if (intent.endsWith("_channel")) {
    if (intent === "add_channel") {
      const type = String(fd.get("type") || "webhook") as channels.ChannelType;
      const def = channels.CHANNEL_TYPES[type];
      if (!def) return redirect("/alerts");
      const cfg: Record<string, string> = {};
      for (const f of def.fields) cfg[f.key] = String(fd.get(f.key) || "").slice(0, 2000);
      const name = String(fd.get("name") || def.label).trim().slice(0, 80) || def.label;
      const id = ulid();
      await channels.insertChannel(orgId, { id, name, type, enabled: true, config: cfg });
      audit(alerts.AlertAudit.ChannelAdd, { channelId: id, name, type });
    } else if (intent === "toggle_channel") {
      const id = String(fd.get("id"));
      await channels.toggleChannel(orgId, id);
      audit(alerts.AlertAudit.ChannelToggle, { channelId: id });
    } else if (intent === "delete_channel") {
      const id = String(fd.get("id"));
      await channels.deleteChannel(orgId, id);
      audit(alerts.AlertAudit.ChannelDelete, { channelId: id });
    } else if (intent === "test_channel") {
      const c = await channels.getChannel(orgId, String(fd.get("id")));
      if (!c) return json({ test: { ok: false, error: "channel not found" } });
      const res = await channels.send(c, {
        title: "backwork test alert",
        body: "This is a test notification from backwork.dev. If you can read this, the channel works.",
        severity: "warning",
      });
      audit(alerts.AlertAudit.ChannelTest, { channelId: c.id, ok: res.ok });
      return json({ test: res });
    }
    return redirect("/alerts");
  }

  // ---- rule intents ----
  if (intent === "preview") {
    const draft = ruleFromDraft(draftInput(fd));
    if (!draft.ok) return json({ preview: { line: null, error: draft.error, breach: false } });
    const rule = { ...draft.rule, id: "preview", enabled: true };
    const reading = await evaluateRule(rule, tenantOf(orgId));
    return json({ preview: { line: previewLine(rule, reading), error: null, breach: isBreach(rule, reading) } });
  }
  if (intent === "add") {
    const draft = ruleFromDraft(draftInput(fd));
    if (!draft.ok) return json({ formError: draft.error }, { status: 400 });
    const id = ulid();
    await alerts.insertRule(orgId, { ...draft.rule, id, enabled: true });
    audit(alerts.AlertAudit.RuleAdd, { ruleId: id, name: draft.rule.name, metric: draft.rule.metric, service: draft.rule.service });
  } else if (intent === "toggle") {
    const id = String(fd.get("id"));
    const rule = await alerts.toggleRule(orgId, id);
    if (rule) {
      // a rule turned off forgets its state, so turning it back on starts afresh
      if (!rule.enabled) await clearState(orgId, id);
      audit(alerts.AlertAudit.RuleToggle, { ruleId: id, enabled: rule.enabled });
    }
  } else if (intent === "delete") {
    const id = String(fd.get("id"));
    await alerts.deleteRule(orgId, id);
    await forgetRule(orgId, id);
    audit(alerts.AlertAudit.RuleDelete, { ruleId: id });
  }
  return redirect("/alerts");
}

function TestButton({ id }: { id: string }) {
  const fetcher = useFetcher<{ test?: { ok: boolean; error?: string } }>();
  const res = fetcher.data?.test;
  return (
    <fetcher.Form method="post" className="inline-flex items-center gap-1.5">
      <input type="hidden" name="intent" value="test_channel" />
      <input type="hidden" name="id" value={id} />
      <button className="inline-flex items-center gap-1 text-2xs text-muted hover:text-fg" disabled={fetcher.state !== "idle"}>
        <Send className="h-3 w-3" /> {fetcher.state !== "idle" ? "sending" : "test"}
      </button>
      {res ? (
        res.ok ? <span className="inline-flex items-center gap-0.5 text-2xs text-ok"><Check className="h-3 w-3" />sent</span>
        : <span className="inline-flex items-center gap-0.5 text-2xs text-err" title={res.error}><X className="h-3 w-3" />{(res.error || "failed").slice(0, 24)}</span>
      ) : null}
    </fetcher.Form>
  );
}

function AddChannelForm({ types }: { types: Record<string, { label: string; hint: string; fields: { key: string; label: string; placeholder?: string; secret?: boolean }[] }> }) {
  const [type, setType] = useState("webhook");
  const def = types[type];
  return (
    <Form method="post" className="space-y-3 p-4">
      <input type="hidden" name="intent" value="add_channel" />
      <div className="grid gap-3 sm:grid-cols-3">
        <label className="text-2xs font-medium text-muted">
          Type
          <select name="type" value={type} onChange={(e) => setType(e.target.value)} className={cn(FIELD, "mt-1")}>
            {Object.entries(types).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
          </select>
        </label>
        <label className="text-2xs font-medium text-muted sm:col-span-2">
          Name
          <input name="name" placeholder={def.label + " channel"} className={cn(FIELD, "mt-1")} />
        </label>
      </div>
      <p className="text-2xs text-faint">{def.hint}</p>
      <div className="grid gap-3 sm:grid-cols-2">
        {def.fields.map((f) => (
          <label key={f.key} className="text-2xs font-medium text-muted">
            {f.label}
            <input name={f.key} type={f.secret ? "password" : "text"} placeholder={f.placeholder} className={cn(FIELD, "mt-1 font-mono")} />
          </label>
        ))}
      </div>
      <button type="submit" className="inline-flex h-9 items-center justify-center gap-1.5 rounded-lg bg-brand px-3 text-[13px] font-medium text-brand-fg hover:opacity-90">
        <Plus className="h-4 w-4" /> Add channel
      </button>
    </Form>
  );
}

type Preview = { line: string | null; error: string | null; breach: boolean };

/** Delay before the "Right now" check runs after the last change (ms). */
const PREVIEW_DEBOUNCE_MS = 500;

/** Fields that change what the rule reads (the name and channels do not). */
function previewKey(d: RuleDraft): string {
  return [d.metric, d.service, d.comparator, d.threshold, d.route, d.window, d.minRequests, d.shape, d.minCalls].join("\u0000");
}

function NewRuleForm({ targets, channelList, formError }: {
  targets: Promise<AlertTargets>;
  channelList: Array<{ id: string; name: string; type: string }>;
  formError: string | null;
}) {
  const [draft, setDraft] = useState<RuleDraft>(EMPTY_DRAFT);
  const preview = useFetcher<{ preview?: Preview }>();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const key = previewKey(draft);
  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      const fd = new FormData();
      fd.set("intent", "preview");
      for (const [k, v] of Object.entries(draft)) fd.set(k, v);
      preview.submit(fd, { method: "post" });
    }, PREVIEW_DEBOUNCE_MS);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const p = preview.data?.preview;
  const fields = (t: AlertTargets | null) => <AlertFormFields draft={draft} onChange={setDraft} targets={t} />;
  return (
    <Form method="post" className="space-y-3 p-4">
      <input type="hidden" name="intent" value="add" />
      <div className="grid gap-3 lg:grid-cols-12 lg:items-start">
        <label className="lg:col-span-3 text-2xs font-medium text-muted">Name<input name="name" required placeholder="Slow checkout" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} className={cn(FIELD, "mt-1")} /></label>
        <label className="lg:col-span-3 text-2xs font-medium text-muted">
          Metric
          <select name="metric" value={draft.metric} onChange={(e) => setDraft(draftForMetric(draft, e.target.value))} className={cn(FIELD, "mt-1")}>
            {Object.entries(METRIC_META).map(([k, m]) => <option key={k} value={k}>{m.label}</option>)}
          </select>
        </label>
        <Deferred resolve={targets} fallback={fields(null)}>{(t) => fields(t)}</Deferred>
      </div>
      <p className={cn("min-h-4 text-2xs", p?.error ? "text-faint" : p?.breach ? "text-warn" : "text-muted")} aria-live="polite">
        {preview.state !== "idle" && !p ? "Checking" : p?.line ?? (p?.error ? `Not checked yet: ${p.error}` : "")}
      </p>
      {channelList.length > 0 ? (
        <div>
          <div className="mb-1.5 text-2xs font-medium text-muted">Notify channels</div>
          <div className="flex flex-wrap gap-3">
            {channelList.map((c) => (
              <label key={c.id} className="inline-flex items-center gap-1.5 text-[13px]">
                <input type="checkbox" name="channelIds" value={c.id} className="accent-[oklch(0.6_0.18_16)]" />
                {c.name} <span className="text-2xs text-faint">{c.type}</span>
              </label>
            ))}
          </div>
        </div>
      ) : (
        <p className="text-2xs text-faint">Add a channel below to get notified when a rule fires.</p>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <button type="submit" className="inline-flex h-9 items-center justify-center gap-1.5 rounded-lg bg-brand px-3 text-[13px] font-medium text-brand-fg hover:opacity-90"><Plus className="h-4 w-4" /> Add rule</button>
        {formError ? <p role="alert" className="text-[13px] text-err">{formError}</p> : null}
      </div>
    </Form>
  );
}

function StatusBadge({ status, pendingSince }: { status: RuleStatus; pendingSince: string | null }) {
  switch (status) {
    case RuleStatus.Retired:
      return <Badge>retired</Badge>;
    case RuleStatus.Disabled:
      return <Badge>disabled</Badge>;
    case RuleStatus.NoData:
      return <Badge tone="warn">no data</Badge>;
    case RuleStatus.Firing:
      return <Badge tone="err">firing</Badge>;
    case RuleStatus.Pending:
      return <span title={pendingSince ? `over the limit since ${pendingSince}` : "over the limit, waiting before it fires"}><Badge tone="warn">pending</Badge></span>;
    case RuleStatus.Ok:
      return <Badge tone="ok">ok</Badge>;
  }
}

export default function Alerts() {
  const d = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const formError = actionData && "formError" in actionData && typeof actionData.formError === "string" ? actionData.formError : null;
  return (
    <div className="space-y-5 animate-fade-in">
      <PageTitle title="Alerts" sub="Thresholds on route p95, route errors, slow queries and log rates, checked every minute and delivered to your channels (webhook, Slack, Discord, email, SMS)." />

      <Deferred resolve={d.data} fallback={<Card><RowsSkeleton rows={8} /></Card>}>
        {(dd) => {
          const rows = dd.rows;
          const channels = dd.channels;
          const firing = rows.filter((s) => s.status === RuleStatus.Firing).length;
          const enabled = rows.filter((s) => s.enabled).length;
          const chanName = (id: string) => channels.find((c) => c.id === id)?.name || id;
          return (
            <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Card className="px-4 py-3.5">
          <div className="text-2xs uppercase tracking-wide text-faint">Rules</div>
          <div className="mt-1 font-mono text-2xl font-semibold tabular-nums">{rows.length}</div>
        </Card>
        <Card className="px-4 py-3.5">
          <div className="text-2xs uppercase tracking-wide text-faint">Firing now</div>
          <div className={cn("mt-1 font-mono text-2xl font-semibold tabular-nums", firing > 0 ? "text-err" : "text-ok")}>{firing}</div>
        </Card>
        <Card className="px-4 py-3.5">
          <div className="text-2xs uppercase tracking-wide text-faint">Enabled</div>
          <div className="mt-1 font-mono text-2xl font-semibold tabular-nums">{enabled}</div>
        </Card>
        <Card className="px-4 py-3.5">
          <div className="text-2xs uppercase tracking-wide text-faint">Channels</div>
          <div className="mt-1 font-mono text-2xl font-semibold tabular-nums">{channels.length}</div>
        </Card>
      </div>

      <Card>
        <CardHead title="Rules" sub="target, condition, live value, status, channels" />
        {rows.length === 0 ? (
          <Empty title="No alert rules">Add one below.</Empty>
        ) : (
          <div className="overflow-x-auto scroll-thin">
            <table className="w-full text-[13px]">
              <thead>
                <tr className="border-b border-border text-left text-2xs uppercase tracking-wide text-faint">
                  <th className="px-4 py-2 font-medium">Name</th>
                  <th className="px-4 py-2 font-medium">Target and condition</th>
                  <th className="hidden px-4 py-2 font-medium sm:table-cell">Channels</th>
                  <th className="px-4 py-2 text-right font-medium">Value</th>
                  <th className="px-4 py-2 font-medium">Status</th>
                  <th className="px-4 py-2"></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((s) => (
                  <tr key={s.id} className="border-b border-border/60 align-top last:border-0 hover:bg-surface-2/50">
                    <td className="px-4 py-2.5 font-medium">
                      {s.name}
                      {s.retired ? <p className="mt-0.5 max-w-[48ch] whitespace-normal text-2xs font-normal text-muted">{s.retired}</p> : null}
                      {s.history.length ? (
                        <details className="mt-1 text-2xs font-normal text-muted">
                          <summary className="cursor-pointer select-none text-faint hover:text-fg">History ({s.history.length})</summary>
                          <ul className="mt-1 space-y-0.5">
                            {s.history.map((e) => (
                              <li key={e.id} className="whitespace-nowrap">
                                <span className={e.kind === "firing" ? "text-warn" : "text-ok"}>{e.kind}</span>
                                {e.value ? <span className="font-mono"> {e.value}</span> : null}
                                <span className="text-faint">, {e.at}</span>
                                {e.delivered === null ? <span className="text-faint">, not delivered yet</span>
                                  : e.delivered.length === 0 ? <span className="text-faint">, no channel</span>
                                  : e.delivered.map((x) => <span key={x.name} className={x.ok ? "text-faint" : "text-err"} title={x.text}>, {x.ok ? `sent to ${x.name}` : `${x.name} failed`}</span>)}
                              </li>
                            ))}
                          </ul>
                        </details>
                      ) : null}
                    </td>
                    <td className="px-4 py-2.5 font-mono text-2xs text-muted">
                      <div className="text-fg/80">{s.target}</div>
                      <div>{s.condition}{s.forMinutes > 0 ? `, for ${s.forMinutes} min` : ""}</div>
                    </td>
                    <td className="hidden px-4 py-2.5 text-2xs sm:table-cell">
                      {s.channelIds.length === 0 ? <span className="text-faint">none</span> :
                        <span className="flex flex-wrap gap-1">{s.channelIds.map((id) => <Badge key={id} tone="info">{chanName(id)}</Badge>)}</span>}
                    </td>
                    <td className="whitespace-nowrap px-4 py-2.5 text-right font-mono tabular-nums" title={s.valueNote ?? undefined}>{s.value === null ? <span className="text-faint">no data</span> : s.value}</td>
                    <td className="px-4 py-2.5"><StatusBadge status={s.status} pendingSince={s.pendingSince} /></td>
                    <td className="px-4 py-2.5">
                      <div className="flex items-center justify-end gap-3">
                        {s.retired ? null : <Form method="post"><input type="hidden" name="intent" value="toggle" /><input type="hidden" name="id" value={s.id} /><button className="text-2xs text-muted hover:text-fg">{s.enabled ? "disable" : "enable"}</button></Form>}
                        <Form method="post" onSubmit={(e) => { if (!confirm(`Delete alert rule "${s.name}"?`)) e.preventDefault(); }}><input type="hidden" name="intent" value="delete" /><input type="hidden" name="id" value={s.id} /><button className="text-faint hover:text-err" aria-label="delete rule"><Trash2 className="h-3.5 w-3.5" /></button></Form>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card>
        <CardHead title="New rule" sub="fires when the value stays over the limit for the wait" />
        <NewRuleForm targets={d.targets} channelList={channels} formError={formError} />
      </Card>

      <Card>
        <CardHead title="Channels" sub="where firing alerts are delivered" />
        {channels.length === 0 ? (
          <Empty title="No channels yet">Add a webhook, Slack, Discord, email or SMS channel below.</Empty>
        ) : (
          <ul className="divide-y divide-border">
            {channels.map((c) => (
              <li key={c.id} className="flex items-center gap-3 px-4 py-2.5">
                <Badge tone="info">{c.type}</Badge>
                <span className="font-medium">{c.name}</span>
                <span className="truncate font-mono text-2xs text-faint">{Object.values(c.config).filter(Boolean)[0]}</span>
                {!c.enabled ? <Badge>disabled</Badge> : null}
                <div className="ml-auto flex items-center gap-4">
                  <TestButton id={c.id} />
                  <Form method="post"><input type="hidden" name="intent" value="toggle_channel" /><input type="hidden" name="id" value={c.id} /><button className="text-2xs text-muted hover:text-fg">{c.enabled ? "disable" : "enable"}</button></Form>
                  <Form method="post" onSubmit={(e) => { if (!confirm(`Delete channel "${c.name}"?`)) e.preventDefault(); }}><input type="hidden" name="intent" value="delete_channel" /><input type="hidden" name="id" value={c.id} /><button className="text-faint hover:text-err" aria-label="delete channel"><Trash2 className="h-3.5 w-3.5" /></button></Form>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card>
        <CardHead title="New channel" sub="webhook, Slack, Discord, email or SMS; you supply the destination and credentials" />
        <AddChannelForm types={d.channelTypes} />
      </Card>
            </div>
          );
        }}
      </Deferred>
    </div>
  );
}
