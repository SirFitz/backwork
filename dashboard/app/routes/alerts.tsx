import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json, redirect } from "@remix-run/node";
import { Form, useLoaderData } from "@remix-run/react";
import { BellRing, Plus, Trash2 } from "lucide-react";
import { Badge, Card, CardHeader, Empty } from "~/components/ui";
import * as alerts from "~/lib/alerts.server";
import { safe } from "~/lib/config.server";
import { cn } from "~/lib/utils";

const METRIC_LABEL: Record<string, string> = {
  error_rate: "Error rate (%)",
  p95_latency: "p95 latency (ms)",
  request_rate: "Request rate (req/s)",
  cpu: "CPU (cores)",
};

export async function loader(_args: LoaderFunctionArgs) {
  const states = await safe(() => alerts.evaluate(), [] as alerts.AlertState[]);
  return json({ states: states.data, error: states.error });
}

export async function action({ request }: ActionFunctionArgs) {
  const fd = await request.formData();
  const intent = fd.get("intent");
  const rules = await alerts.loadRules();

  if (intent === "add") {
    rules.push({
      id: "r" + Date.now().toString(36),
      name: String(fd.get("name") || "Untitled alert"),
      metric: (fd.get("metric") as alerts.AlertRule["metric"]) || "error_rate",
      service: String(fd.get("service") || "*"),
      comparator: (fd.get("comparator") as ">" | "<") || ">",
      threshold: Number(fd.get("threshold") || 0),
      channel: String(fd.get("channel") || "#alerts"),
      enabled: true,
    });
  } else if (intent === "toggle") {
    const id = String(fd.get("id"));
    const r = rules.find((x) => x.id === id);
    if (r) r.enabled = !r.enabled;
  } else if (intent === "delete") {
    const id = String(fd.get("id"));
    const idx = rules.findIndex((x) => x.id === id);
    if (idx >= 0) rules.splice(idx, 1);
  }
  await alerts.saveRules(rules);
  return redirect("/alerts");
}

export default function Alerts() {
  const d = useLoaderData<typeof loader>();
  const firing = d.states.filter((s) => s.firing).length;

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-lg font-semibold">Alert Rules</h1>
        <p className="text-sm text-muted">Configurable thresholds on any metric. Rules are evaluated live against VictoriaMetrics.</p>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <Card className="px-4 py-3">
          <div className="text-[11px] uppercase tracking-wide text-muted">Rules</div>
          <div className="mt-1 font-mono text-2xl font-semibold">{d.states.length}</div>
        </Card>
        <Card className="px-4 py-3">
          <div className="text-[11px] uppercase tracking-wide text-muted">Firing now</div>
          <div className={cn("mt-1 font-mono text-2xl font-semibold", firing > 0 ? "text-err" : "text-ok")}>{firing}</div>
        </Card>
        <Card className="px-4 py-3">
          <div className="text-[11px] uppercase tracking-wide text-muted">Enabled</div>
          <div className="mt-1 font-mono text-2xl font-semibold">{d.states.filter((s) => s.enabled).length}</div>
        </Card>
      </div>

      <Card>
        <CardHeader title="Rules" subtitle="threshold · live value · status" />
        {d.states.length === 0 ? (
          <Empty>No alert rules.</Empty>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-[11px] uppercase tracking-wide text-muted">
                <th className="px-4 py-2 font-medium">Name</th>
                <th className="px-4 py-2 font-medium">Condition</th>
                <th className="px-4 py-2 font-medium">Channel</th>
                <th className="px-4 py-2 text-right font-medium">Value</th>
                <th className="px-4 py-2 font-medium">Status</th>
                <th className="px-4 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {d.states.map((s) => (
                <tr key={s.id} className="border-b border-border/40 last:border-0 hover:bg-panel-2/40">
                  <td className="px-4 py-2.5 font-medium">{s.name}</td>
                  <td className="px-4 py-2.5 font-mono text-xs text-muted">
                    {s.service === "*" ? "any" : s.service} · {METRIC_LABEL[s.metric]} {s.comparator} {s.threshold}
                  </td>
                  <td className="px-4 py-2.5 text-xs text-info">{s.channel}</td>
                  <td className="px-4 py-2.5 text-right font-mono tabular-nums">{s.value.toFixed(2)}</td>
                  <td className="px-4 py-2.5">
                    {!s.enabled ? (
                      <Badge>disabled</Badge>
                    ) : s.firing ? (
                      <Badge tone="err">firing</Badge>
                    ) : (
                      <Badge tone="ok">ok</Badge>
                    )}
                  </td>
                  <td className="px-4 py-2.5">
                    <div className="flex items-center justify-end gap-2">
                      <Form method="post">
                        <input type="hidden" name="intent" value="toggle" />
                        <input type="hidden" name="id" value={s.id} />
                        <button className="text-xs text-muted hover:text-fg">{s.enabled ? "disable" : "enable"}</button>
                      </Form>
                      <Form method="post">
                        <input type="hidden" name="intent" value="delete" />
                        <input type="hidden" name="id" value={s.id} />
                        <button className="text-muted hover:text-err" title="delete"><Trash2 className="h-3.5 w-3.5" /></button>
                      </Form>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <Card>
        <CardHeader title="New rule" subtitle="fires when the live value crosses the threshold" />
        <Form method="post" className="grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-6 lg:items-end">
          <input type="hidden" name="intent" value="add" />
          <label className="lg:col-span-2 text-xs text-muted">
            Name
            <input name="name" required placeholder="High error rate" className="mt-1 w-full rounded-md border border-border bg-panel px-2.5 py-1.5 text-sm text-fg outline-none focus:border-brand/50" />
          </label>
          <label className="text-xs text-muted">
            Metric
            <select name="metric" className="mt-1 w-full rounded-md border border-border bg-panel px-2.5 py-1.5 text-sm text-fg outline-none focus:border-brand/50">
              {Object.entries(METRIC_LABEL).map(([k, v]) => (
                <option key={k} value={k}>{v}</option>
              ))}
            </select>
          </label>
          <label className="text-xs text-muted">
            Service
            <input name="service" defaultValue="*" className="mt-1 w-full rounded-md border border-border bg-panel px-2.5 py-1.5 text-sm font-mono text-fg outline-none focus:border-brand/50" />
          </label>
          <label className="text-xs text-muted">
            Condition
            <div className="mt-1 flex gap-1">
              <select name="comparator" className="rounded-md border border-border bg-panel px-2 py-1.5 text-sm text-fg outline-none focus:border-brand/50">
                <option value=">">&gt;</option>
                <option value="<">&lt;</option>
              </select>
              <input name="threshold" type="number" step="any" defaultValue="5" className="w-full rounded-md border border-border bg-panel px-2.5 py-1.5 text-sm font-mono text-fg outline-none focus:border-brand/50" />
            </div>
          </label>
          <button type="submit" className="inline-flex items-center justify-center gap-1.5 rounded-md bg-brand px-3 py-2 text-sm font-medium text-bg hover:bg-brand/90">
            <Plus className="h-4 w-4" /> Add rule
          </button>
        </Form>
      </Card>
    </div>
  );
}
