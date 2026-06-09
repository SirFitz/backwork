import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json, redirect } from "@remix-run/node";
import { Form, useLoaderData } from "@remix-run/react";
import { Plus, Trash2 } from "lucide-react";
import { Badge, Card, CardHead, Empty, PageTitle } from "~/components/ui";
import * as alerts from "~/lib/alerts.server";
import { safe } from "~/lib/config.server";
import { cn, fmtNum } from "~/lib/utils";

export async function loader(_args: LoaderFunctionArgs) {
  const states = await safe(() => alerts.evaluate(), [] as alerts.AlertState[]);
  return json({ states: states.data, error: states.error, meta: alerts.METRIC_META });
}

export async function action({ request }: ActionFunctionArgs) {
  const fd = await request.formData();
  const intent = fd.get("intent");
  const rules = await alerts.loadRules();
  if (intent === "add") {
    rules.push({
      id: "r" + Date.now().toString(36),
      name: String(fd.get("name") || "Untitled alert"),
      metric: (fd.get("metric") as alerts.AlertMetric) || "error_rate",
      service: String(fd.get("service") || "*").trim() || "*",
      comparator: (fd.get("comparator") as ">" | "<") || ">",
      threshold: Number(fd.get("threshold") || 0),
      channel: String(fd.get("channel") || "#alerts"),
      enabled: true,
    });
  } else if (intent === "toggle") {
    const r = rules.find((x) => x.id === String(fd.get("id")));
    if (r) r.enabled = !r.enabled;
  } else if (intent === "delete") {
    const i = rules.findIndex((x) => x.id === String(fd.get("id")));
    if (i >= 0) rules.splice(i, 1);
  }
  await alerts.saveRules(rules);
  return redirect("/alerts");
}

const FIELD = "h-9 w-full rounded-lg border border-border bg-surface px-2.5 text-[13px] outline-none focus:border-brand/40";

export default function Alerts() {
  const d = useLoaderData<typeof loader>();
  const firing = d.states.filter((s) => s.firing).length;

  return (
    <div className="space-y-5 animate-fade-in">
      <PageTitle title="Alerts" sub="Thresholds on real metrics and log rates, evaluated live against VictoriaMetrics and Loki on every refresh." />

      <Card>
        <CardHead
          title="Rules"
          sub="condition, live value, status"
          right={<Badge tone={firing > 0 ? "err" : "ok"}>{firing} firing</Badge>}
        />
        {d.states.length === 0 ? (
          <Empty title="No alert rules">Add one below.</Empty>
        ) : (
          <div className="overflow-x-auto scroll-thin">
            <table className="w-full text-[13px]">
              <thead>
                <tr className="border-b border-border text-left text-2xs uppercase tracking-wide text-faint">
                  <th className="px-4 py-2 font-medium">Name</th>
                  <th className="px-4 py-2 font-medium">Condition</th>
                  <th className="px-4 py-2 font-medium">Channel</th>
                  <th className="px-4 py-2 text-right font-medium">Value</th>
                  <th className="px-4 py-2 font-medium">Status</th>
                  <th className="px-4 py-2"></th>
                </tr>
              </thead>
              <tbody>
                {d.states.map((s) => {
                  const meta = d.meta[s.metric];
                  return (
                    <tr key={s.id} className="border-b border-border/60 last:border-0 hover:bg-surface-2/50">
                      <td className="px-4 py-2.5 font-medium">{s.name}</td>
                      <td className="px-4 py-2.5 font-mono text-2xs text-muted">
                        {s.service === "*" ? "any" : s.service} · {meta.label} {s.comparator} {s.threshold}{meta.unit}
                      </td>
                      <td className="px-4 py-2.5 text-2xs text-info">{s.channel}</td>
                      <td className="px-4 py-2.5 text-right font-mono tabular-nums">{fmtNum(s.value, 2)}{meta.unit}</td>
                      <td className="px-4 py-2.5">
                        {!s.enabled ? <Badge>disabled</Badge> : s.firing ? <Badge tone="err">firing</Badge> : <Badge tone="ok">ok</Badge>}
                      </td>
                      <td className="px-4 py-2.5">
                        <div className="flex items-center justify-end gap-3">
                          <Form method="post">
                            <input type="hidden" name="intent" value="toggle" />
                            <input type="hidden" name="id" value={s.id} />
                            <button className="text-2xs text-muted hover:text-fg">{s.enabled ? "disable" : "enable"}</button>
                          </Form>
                          <Form method="post">
                            <input type="hidden" name="intent" value="delete" />
                            <input type="hidden" name="id" value={s.id} />
                            <button className="text-faint hover:text-err" aria-label="delete rule"><Trash2 className="h-3.5 w-3.5" /></button>
                          </Form>
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
        <Form method="post" className="grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-12 lg:items-end">
          <input type="hidden" name="intent" value="add" />
          <label className="lg:col-span-3 text-2xs font-medium text-muted">
            Name
            <input name="name" required placeholder="High error rate" className={cn(FIELD, "mt-1")} />
          </label>
          <label className="lg:col-span-2 text-2xs font-medium text-muted">
            Metric
            <select name="metric" className={cn(FIELD, "mt-1")}>
              {Object.entries(d.meta).map(([k, m]) => <option key={k} value={k}>{m.label}</option>)}
            </select>
          </label>
          <label className="lg:col-span-2 text-2xs font-medium text-muted">
            Service
            <input name="service" defaultValue="*" className={cn(FIELD, "mt-1 font-mono")} />
          </label>
          <label className="lg:col-span-1 text-2xs font-medium text-muted">
            Op
            <select name="comparator" className={cn(FIELD, "mt-1")}>
              <option value=">">&gt;</option>
              <option value="<">&lt;</option>
            </select>
          </label>
          <label className="lg:col-span-2 text-2xs font-medium text-muted">
            Threshold
            <input name="threshold" type="number" step="any" defaultValue="2" className={cn(FIELD, "mt-1 font-mono")} />
          </label>
          <div className="lg:col-span-2">
            <button type="submit" className="inline-flex h-9 w-full items-center justify-center gap-1.5 rounded-lg bg-brand px-3 text-[13px] font-medium text-brand-fg transition-colors hover:opacity-90">
              <Plus className="h-4 w-4" /> Add rule
            </button>
          </div>
        </Form>
      </Card>
    </div>
  );
}
