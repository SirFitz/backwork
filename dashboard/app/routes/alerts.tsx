import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { defer, json, redirect } from "@remix-run/node";
import { Form, useFetcher, useLoaderData } from "@remix-run/react";
import { useState } from "react";
import { Check, Plus, Send, Trash2, X } from "lucide-react";
import { Badge, Card, CardHead, Empty, PageTitle } from "~/components/ui";
import { Deferred, RowsSkeleton } from "~/components/defer";
import * as alerts from "~/lib/alerts.server";
import * as channels from "~/lib/channels.server";
import { requireOrg, requireRole } from "~/lib/auth/context.server";
import { tenantOf } from "~/lib/tenant.server";
import { assertSameOrigin } from "~/lib/auth/security.server";
import { cn, fmtNum } from "~/lib/utils";

export async function loader({ request }: LoaderFunctionArgs) {
  const ctx = await requireOrg(request);
  const t = tenantOf(ctx.org.id);
  return defer({
    data: Promise.all([alerts.evaluate(t), channels.loadChannels(ctx.org.id)])
      .then(([states, chans]) => ({ states, channels: chans.map(channels.redact) }))
      .catch(() => ({ states: [] as alerts.AlertState[], channels: [] as ReturnType<typeof channels.redact>[] })),
    meta: alerts.METRIC_META,
    channelTypes: channels.CHANNEL_TYPES,
  });
}

export async function action({ request }: ActionFunctionArgs) {
  assertSameOrigin(request);
  const ctx = await requireOrg(request);
  requireRole(ctx, "member"); // viewers are read-only (H6)
  const orgId = ctx.org.id;
  const fd = await request.formData();
  const intent = String(fd.get("intent"));

  // ---- channel intents ----
  if (intent.endsWith("_channel")) {
    if (intent === "add_channel") {
      const type = String(fd.get("type") || "webhook") as channels.ChannelType;
      const def = channels.CHANNEL_TYPES[type];
      if (!def) return redirect("/alerts");
      const cfg: Record<string, string> = {};
      for (const f of def.fields) cfg[f.key] = String(fd.get(f.key) || "").slice(0, 2000);
      const name = String(fd.get("name") || def.label).trim().slice(0, 80) || def.label;
      await channels.insertChannel(orgId, { id: "c" + Date.now().toString(36), name, type, enabled: true, config: cfg });
    } else if (intent === "toggle_channel") {
      await channels.toggleChannel(orgId, String(fd.get("id")));
    } else if (intent === "delete_channel") {
      await channels.deleteChannel(orgId, String(fd.get("id")));
    } else if (intent === "test_channel") {
      const c = await channels.getChannel(orgId, String(fd.get("id")));
      if (!c) return json({ test: { ok: false, error: "channel not found" } });
      const res = await channels.send(c, {
        title: "backwork test alert",
        body: "This is a test notification from backwork.dev. If you can read this, the channel works.",
        severity: "warning",
      });
      return json({ test: res });
    }
    return redirect("/alerts");
  }

  // ---- rule intents ----
  if (intent === "add") {
    const metric = String(fd.get("metric") || "");
    const comparator = String(fd.get("comparator") || "");
    const threshold = Number(fd.get("threshold"));
    if (!(metric in alerts.METRIC_META)) return json({ formError: "Pick a valid metric." }, { status: 400 });
    if (comparator !== ">" && comparator !== "<") return json({ formError: "Pick a valid comparator." }, { status: 400 });
    if (!Number.isFinite(threshold)) return json({ formError: "Threshold must be a number." }, { status: 400 });
    await alerts.insertRule(orgId, {
      id: "r" + Date.now().toString(36),
      name: String(fd.get("name") || "Untitled alert").trim().slice(0, 80) || "Untitled alert",
      metric: metric as alerts.AlertMetric,
      service: String(fd.get("service") || "*").trim().slice(0, 120) || "*",
      comparator: comparator as ">" | "<",
      threshold,
      channelIds: fd.getAll("channelIds").map(String),
      enabled: true,
    });
  } else if (intent === "toggle") {
    await alerts.toggleRule(orgId, String(fd.get("id")));
  } else if (intent === "delete") {
    await alerts.deleteRule(orgId, String(fd.get("id")));
  }
  return redirect("/alerts");
}

const FIELD = "h-9 w-full rounded-lg border border-border bg-surface px-2.5 text-[13px] outline-none focus:border-brand/40";

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

export default function Alerts() {
  const d = useLoaderData<typeof loader>();
  return (
    <div className="space-y-5 animate-fade-in">
      <PageTitle title="Alerts" sub="Thresholds on real metrics and log rates, evaluated live and delivered to your channels (webhook, Slack, Discord, email, SMS)." />

      <Deferred resolve={d.data} fallback={<Card><RowsSkeleton rows={8} /></Card>}>
        {(dd) => {
          const states = dd.states;
          const channels = dd.channels;
          const firing = states.filter((s) => s.firing).length;
          const enabled = states.filter((s) => s.enabled).length;
          const chanName = (id: string) => channels.find((c) => c.id === id)?.name || id;
          return (
            <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Card className="px-4 py-3.5">
          <div className="text-2xs uppercase tracking-wide text-faint">Rules</div>
          <div className="mt-1 font-mono text-2xl font-semibold tabular-nums">{states.length}</div>
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
        <CardHead title="Rules" sub="condition, live value, status, channels" />
        {states.length === 0 ? (
          <Empty title="No alert rules">Add one below.</Empty>
        ) : (
          <div className="overflow-x-auto scroll-thin">
            <table className="w-full text-[13px]">
              <thead>
                <tr className="border-b border-border text-left text-2xs uppercase tracking-wide text-faint">
                  <th className="px-4 py-2 font-medium">Name</th>
                  <th className="px-4 py-2 font-medium">Condition</th>
                  <th className="px-4 py-2 font-medium">Channels</th>
                  <th className="px-4 py-2 text-right font-medium">Value</th>
                  <th className="px-4 py-2 font-medium">Status</th>
                  <th className="px-4 py-2"></th>
                </tr>
              </thead>
              <tbody>
                {states.map((s) => {
                  const meta = d.meta[s.metric];
                  const unit = meta?.unit ?? "";
                  return (
                    <tr key={s.id} className="border-b border-border/60 last:border-0 hover:bg-surface-2/50">
                      <td className="px-4 py-2.5 font-medium">{s.name}</td>
                      <td className="px-4 py-2.5 font-mono text-2xs text-muted">{s.service === "*" ? "any" : s.service} · {meta?.label ?? s.metric} {s.comparator} {s.threshold}{unit}</td>
                      <td className="px-4 py-2.5 text-2xs">
                        {(s.channelIds || []).length === 0 ? <span className="text-faint">none</span> :
                          <span className="flex flex-wrap gap-1">{(s.channelIds || []).map((id) => <Badge key={id} tone="info">{chanName(id)}</Badge>)}</span>}
                      </td>
                      <td className="px-4 py-2.5 text-right font-mono tabular-nums">{s.noData ? <span className="text-faint">—</span> : <>{fmtNum(s.value, 2)}{unit}</>}</td>
                      <td className="px-4 py-2.5">{!s.enabled ? <Badge>disabled</Badge> : s.noData ? <Badge tone="warn">no data</Badge> : s.firing ? <Badge tone="err">firing</Badge> : <Badge tone="ok">ok</Badge>}</td>
                      <td className="px-4 py-2.5">
                        <div className="flex items-center justify-end gap-3">
                          <Form method="post"><input type="hidden" name="intent" value="toggle" /><input type="hidden" name="id" value={s.id} /><button className="text-2xs text-muted hover:text-fg">{s.enabled ? "disable" : "enable"}</button></Form>
                          <Form method="post" onSubmit={(e) => { if (!confirm(`Delete alert rule "${s.name}"?`)) e.preventDefault(); }}><input type="hidden" name="intent" value="delete" /><input type="hidden" name="id" value={s.id} /><button className="text-faint hover:text-err" aria-label="delete rule"><Trash2 className="h-3.5 w-3.5" /></button></Form>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card>
        <CardHead title="New rule" sub="fires when the live value crosses the threshold" />
        <Form method="post" className="space-y-3 p-4">
          <input type="hidden" name="intent" value="add" />
          <div className="grid gap-3 lg:grid-cols-12 lg:items-end">
            <label className="lg:col-span-3 text-2xs font-medium text-muted">Name<input name="name" required placeholder="High error rate" className={cn(FIELD, "mt-1")} /></label>
            <label className="lg:col-span-3 text-2xs font-medium text-muted">Metric<select name="metric" className={cn(FIELD, "mt-1")}>{Object.entries(d.meta).map(([k, m]) => <option key={k} value={k}>{m.label}</option>)}</select></label>
            <label className="lg:col-span-2 text-2xs font-medium text-muted">Service<input name="service" defaultValue="*" className={cn(FIELD, "mt-1 font-mono")} /></label>
            <label className="lg:col-span-1 text-2xs font-medium text-muted">Op<select name="comparator" className={cn(FIELD, "mt-1")}><option value=">">&gt;</option><option value="<">&lt;</option></select></label>
            <label className="lg:col-span-1 text-2xs font-medium text-muted">Value<input name="threshold" type="number" step="any" defaultValue="2" className={cn(FIELD, "mt-1 font-mono")} /></label>
            <div className="lg:col-span-2"><button type="submit" className="inline-flex h-9 w-full items-center justify-center gap-1.5 rounded-lg bg-brand px-3 text-[13px] font-medium text-brand-fg hover:opacity-90"><Plus className="h-4 w-4" /> Add rule</button></div>
          </div>
          {channels.length > 0 ? (
            <div>
              <div className="mb-1.5 text-2xs font-medium text-muted">Notify channels</div>
              <div className="flex flex-wrap gap-3">
                {channels.map((c) => (
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
        </Form>
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
        <CardHead title="New channel" sub="webhook · Slack · Discord · email · SMS — you supply the destination/credentials" />
        <AddChannelForm types={d.channelTypes} />
      </Card>
            </div>
          );
        }}
      </Deferred>
    </div>
  );
}
