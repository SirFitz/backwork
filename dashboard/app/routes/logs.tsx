import type { LoaderFunctionArgs } from "@remix-run/node";
import { defer } from "@remix-run/node";
import { Await, Form, useLoaderData, useNavigation, useSubmit } from "@remix-run/react";
import { Suspense } from "react";
import { Search } from "lucide-react";
import { Badge, Card, CardHead, Empty, PageTitle } from "~/components/ui";
import { ChartSkeleton, Deferred, RowsSkeleton } from "~/components/defer";
import { AreaSeries } from "~/components/charts";
import * as loki from "~/lib/loki.server";
import { cached } from "~/lib/cache.server";
import { requireOrg } from "~/lib/auth/context.server";
import { tenantOf } from "~/lib/tenant.server";
import { cn, fmtClock, fmtNum, LEVEL_TEXT } from "~/lib/utils";

const LEVELS = ["all", "error", "warn", "info", "debug"];
const RANGES: Record<string, number> = { "15m": 15, "1h": 60, "6h": 360, "24h": 1440 };

function buildQuery(service: string, level: string, q: string): string {
  if (q.trim().startsWith("{")) return q.trim();
  const m: string[] = [];
  if (service && service !== "all") m.push(`service=${JSON.stringify(service)}`);
  if (level && level !== "all") m.push(`level="${level}"`);
  if (m.length === 0) m.push(`service=~".+"`);
  let query = `{${m.join(",")}}`;
  if (q.trim()) query += ` |~ "(?i)${q.trim().replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  return query;
}

export async function loader({ request }: LoaderFunctionArgs) {
  const url = new URL(request.url);
  const service = url.searchParams.get("service") || "all";
  const level = url.searchParams.get("level") || "all";
  const q = url.searchParams.get("q") || "";
  const rangeKey = url.searchParams.get("range") || "15m";
  const mins = RANGES[rangeKey] ?? 15;
  const end = Date.now();
  const start = end - mins * 60 * 1000;
  const query = buildQuery(service, level, q);
  const ctx = await requireOrg(request);
  const t = tenantOf(ctx.org.id);
  const ck = `logs:${t.orgId}:${rangeKey}:${query}`;
  return defer({
    services: loki.services(t).catch(() => [] as string[]),
    query,
    filters: { service, level, q, range: rangeKey },
    entries: cached(`${ck}:e`, 5000, () => loki.queryRange(query, { start, end, limit: 200 }, t)),
    volume: cached(`${ck}:v`, 5000, () => loki.countOverTime(`sum(count_over_time(${query} [1m]))`, { start, end, step: "60s" }, t)).then((d) => d.map((p) => ({ t: p.t, v: p.v }))),
  });
}

const SELECT = "h-9 rounded-lg border border-border bg-surface px-3 text-[13px] outline-none focus:border-brand/40";

export default function Logs() {
  const d = useLoaderData<typeof loader>();
  const submit = useSubmit();
  const nav = useNavigation();
  const loading = nav.state === "loading";
  const f = d.filters;

  return (
    <div className="space-y-4 animate-fade-in">
      <PageTitle title="Logs" sub="Full-text and structured search across every container's output. Pick a service and level, or paste raw LogQL." />

      <Form method="get" className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[280px] flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-faint" />
          <input name="q" defaultValue={f.q} placeholder={'Search text, or LogQL like {service="commerce-api"} |= "timeout"  ·  Enter to run'} className="h-9 w-full rounded-lg border border-border bg-surface pl-9 pr-3 font-mono text-[13px] outline-none placeholder:text-faint focus:border-brand/40" />
        </div>
        <select name="service" defaultValue={f.service} onChange={(e) => submit(e.currentTarget.form)} className={SELECT}>
          <option value="all">all services</option>
          <Suspense fallback={f.service !== "all" ? <option value={f.service}>{f.service}</option> : null}>
            <Await resolve={d.services}>{(svcs: string[]) => <>{svcs.map((s) => <option key={s} value={s}>{s}</option>)}</>}</Await>
          </Suspense>
        </select>
        <select name="level" defaultValue={f.level} onChange={(e) => submit(e.currentTarget.form)} className={SELECT}>
          {LEVELS.map((l) => <option key={l} value={l}>{l === "all" ? "all levels" : l}</option>)}
        </select>
        <select name="range" defaultValue={f.range} onChange={(e) => submit(e.currentTarget.form)} className={SELECT}>
          {Object.keys(RANGES).map((r) => <option key={r} value={r}>{r}</option>)}
        </select>
      </Form>

      <Card>
        <CardHead title="Volume" sub={<span className="font-mono">{d.query}</span>} />
        <Deferred resolve={d.volume} fallback={<ChartSkeleton height={80} />}>
          {(points) => <div className="p-3"><AreaSeries points={points} color="oklch(0.58 0.13 240)" height={80} fmt={(n) => fmtNum(n, 0)} /></div>}
        </Deferred>
      </Card>

      <Card>
        <Deferred resolve={d.entries} fallback={<RowsSkeleton rows={10} />}>
          {(entries) =>
            entries.length === 0 ? (
              <Empty title="No log lines match">Widen the time range, clear the filters, or check the query.</Empty>
            ) : (
              <div className={cn("max-h-[62vh] overflow-auto scroll-thin font-mono text-[12.5px] leading-[1.7] transition-opacity", loading && "opacity-50")}>
                {entries.map((e, i) => (
                  <div key={i} className="flex gap-3 border-b border-border/40 px-4 py-1 hover:bg-surface-2/50">
                    <span className="shrink-0 tabular-nums text-faint">{fmtClock(e.ts)}</span>
                    <span className={cn("w-11 shrink-0 font-semibold uppercase", LEVEL_TEXT[e.level] || "text-faint")}>{e.level}</span>
                    <span className="w-40 shrink-0 truncate text-accent" title={e.service}>{e.service}</span>
                    <span className="min-w-0 flex-1 whitespace-pre-wrap break-words text-fg/90">{e.message}</span>
                  </div>
                ))}
              </div>
            )
          }
        </Deferred>
      </Card>
    </div>
  );
}
