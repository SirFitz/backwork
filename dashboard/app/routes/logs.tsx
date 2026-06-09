import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { Form, useLoaderData, useSubmit } from "@remix-run/react";
import { Search } from "lucide-react";
import { Card, CardHeader, Empty, ErrorNote } from "~/components/ui";
import { AreaSeries } from "~/components/charts";
import * as loki from "~/lib/loki.server";
import { safe } from "~/lib/config.server";
import { cn, fmtTime, LEVEL_COLOR } from "~/lib/utils";

const LEVELS = ["all", "error", "warn", "info", "debug"];
const RANGES: Record<string, number> = { "15m": 15, "1h": 60, "6h": 360, "24h": 1440 };

function buildQuery(service: string, level: string, q: string): string {
  if (q.trim().startsWith("{")) return q.trim(); // raw LogQL passthrough
  const matchers: string[] = [];
  if (service && service !== "all") matchers.push(`service="${service}"`);
  if (level && level !== "all") matchers.push(`level="${level}"`);
  if (matchers.length === 0) matchers.push(`service=~".+"`);
  let query = `{${matchers.join(",")}}`;
  if (q.trim()) {
    const esc = q.trim().replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    query += ` |~ "(?i)${esc}"`;
  }
  return query;
}

export async function loader({ request }: LoaderFunctionArgs) {
  const url = new URL(request.url);
  const service = url.searchParams.get("service") || "all";
  const level = url.searchParams.get("level") || "all";
  const q = url.searchParams.get("q") || "";
  const rangeKey = url.searchParams.get("range") || "1h";
  const mins = RANGES[rangeKey] ?? 60;
  const end = Date.now();
  const start = end - mins * 60 * 1000;

  const query = buildQuery(service, level, q);
  const [services, entries, volume] = await Promise.all([
    safe(() => loki.services(), [] as string[]),
    safe(() => loki.queryRange(query, { start, end, limit: 300 }), [] as loki.LogEntry[]),
    safe(
      () => loki.countOverTime(`sum(count_over_time(${query} [1m]))`, { start, end, step: "60s" }),
      [] as Array<{ t: number; v: number; labels: Record<string, string> }>
    ),
  ]);

  return json({
    services: services.data,
    entries: entries.data,
    error: entries.error,
    volume: volume.data.map((p) => ({ t: p.t, v: p.v })),
    query,
    filters: { service, level, q, range: rangeKey },
  });
}

export default function Logs() {
  const d = useLoaderData<typeof loader>();
  const submit = useSubmit();
  const f = d.filters;

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg font-semibold">Logs</h1>
        <p className="text-sm text-muted">Full-text and structured search across every ingested source. Without search, logs are just stale.</p>
      </div>

      <Form method="get" className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[260px]">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
          <input
            name="q"
            defaultValue={f.q}
            placeholder='search… (free text, or paste LogQL like {service="api"} |= "timeout") — Enter to run'
            className="w-full rounded-md border border-border bg-panel py-2 pl-9 pr-3 text-sm font-mono outline-none placeholder:text-muted/70 focus:border-brand/50"
          />
        </div>
        <select name="service" defaultValue={f.service} onChange={(e) => submit(e.currentTarget.form)} className="rounded-md border border-border bg-panel px-3 py-2 text-sm outline-none focus:border-brand/50">
          <option value="all">all services</option>
          {d.services.map((s) => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>
        <select name="level" defaultValue={f.level} onChange={(e) => submit(e.currentTarget.form)} className="rounded-md border border-border bg-panel px-3 py-2 text-sm outline-none focus:border-brand/50">
          {LEVELS.map((l) => (
            <option key={l} value={l}>{l === "all" ? "all levels" : l}</option>
          ))}
        </select>
        <select name="range" defaultValue={f.range} onChange={(e) => submit(e.currentTarget.form)} className="rounded-md border border-border bg-panel px-3 py-2 text-sm outline-none focus:border-brand/50">
          {Object.keys(RANGES).map((r) => (
            <option key={r} value={r}>{r}</option>
          ))}
        </select>
        <button type="submit" className="rounded-md border border-border bg-panel px-3 py-2 text-sm text-muted hover:bg-panel-2 hover:text-fg">Run</button>
      </Form>

      <Card>
        <CardHeader title="Volume" subtitle={<span className="font-mono text-[11px]">{d.query}</span>} right={<span className="text-xs text-muted">{d.entries.length} lines</span>} />
        <div className="p-2"><AreaSeries points={d.volume} color="#58a6ff" height={90} /></div>
      </Card>

      <Card>
        <ErrorNote error={d.error} />
        {d.entries.length === 0 ? (
          <Empty>No log lines match. Try widening the time range or clearing filters.</Empty>
        ) : (
          <div className="max-h-[60vh] overflow-auto scroll-thin font-mono text-[12.5px] leading-relaxed">
            {d.entries.map((e, i) => (
              <div key={i} className="flex gap-3 border-b border-border/30 px-4 py-1.5 hover:bg-panel-2/40">
                <span className="shrink-0 tabular-nums text-muted">{fmtTime(e.ts)}</span>
                <span className={cn("w-12 shrink-0 font-semibold uppercase", LEVEL_COLOR[e.level] || "text-muted")}>{e.level}</span>
                <span className="w-20 shrink-0 truncate text-accent">{e.service}</span>
                <span className="min-w-0 flex-1 whitespace-pre-wrap break-words text-fg/90">{e.message}</span>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
