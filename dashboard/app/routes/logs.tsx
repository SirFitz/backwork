import type { LoaderFunctionArgs } from "@remix-run/node";
import { defer } from "@remix-run/node";
import { Await, Form, Link, useLoaderData, useNavigation, useSubmit } from "@remix-run/react";
import { Suspense, useState } from "react";
import { GitBranch, Search, SlidersHorizontal } from "lucide-react";
import { Badge, Card, CardHead, Empty, PageTitle } from "~/components/ui";
import { ChartSkeleton, Deferred, RowsSkeleton } from "~/components/defer";
import { AreaSeries } from "~/components/charts";
import * as loki from "~/lib/loki.server";
import { cached } from "~/lib/cache.server";
import { requireOrg } from "~/lib/auth/context.server";
import { tenantOf } from "~/lib/tenant.server";
import { cn, fmtNum, LEVEL_TEXT } from "~/lib/utils";
import { stripAnsi, traceIdOfLine } from "~/lib/hops/parse";
import { Clock } from "~/components/time";
import { displayService, serviceList, serviceMatcher, type ServiceNames } from "~/lib/service-names";
import { serviceNames } from "~/lib/service-names.server";

const LEVELS = ["all", "error", "warn", "info", "debug"];
/** pino writes numeric levels; show their names. */
const PINO_LEVELS: Readonly<Record<string, string>> = { "10": "trace", "20": "debug", "30": "info", "40": "warn", "50": "error", "60": "fatal" };
function levelName(level: string): string {
  return PINO_LEVELS[level] ?? level;
}
const RANGES: Record<string, number> = { "15m": 15, "1h": 60, "6h": 360, "24h": 1440 };
const DEFAULT_RANGE = "15m";

/** Hop records are log lines too (design 8): hidden unless "Show hop records" is on.
 *  A raw LogQL query is taken as written. */
function matchers(service: string, level: string, names: ServiceNames): string[] {
  const m: string[] = [];
  // One service, one name: its hop records and its ordinary lines, under whichever label (BAC-51).
  if (service && service !== "all") m.push(serviceMatcher(service, names));
  if (level && level !== "all") m.push(`level="${level}"`);
  if (m.length === 0) m.push(`service=~".+"`);
  return m;
}

/** Which lines a query selects by kind: ordinary lines only, everything, or hop records only. */
const KindFilter = { Ordinary: `kind!="hop"`, All: "", Hops: `kind="hop"` } as const;
type KindFilter = (typeof KindFilter)[keyof typeof KindFilter];

function buildQuery(service: string, level: string, q: string, kind: KindFilter, names: ServiceNames): string {
  if (q.trim().startsWith("{")) return q.trim();
  const m = matchers(service, level, names);
  if (kind) m.push(kind);
  let query = `{${m.join(", ")}}`;
  // literal, case-insensitive substring match — escape regex metacharacters so
  // a user search like "GET /x?y=1" or "(foo)" doesn't break the LogQL query (M9)
  if (q.trim()) {
    const esc = q.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/"/g, '\\"');
    query += ` |~ "(?i)${esc}"`;
  }
  return query;
}

export async function loader({ request }: LoaderFunctionArgs) {
  const url = new URL(request.url);
  const service = url.searchParams.get("service") || "all";
  const level = url.searchParams.get("level") || "all";
  const q = url.searchParams.get("q") || "";
  const rangeKey = url.searchParams.get("range") || DEFAULT_RANGE;
  const mins = RANGES[rangeKey] ?? 15;
  const end = Date.now();
  const start = end - mins * 60 * 1000;
  const showHops = url.searchParams.get("hops") === "1";
  const raw = q.trim().startsWith("{");
  const ctx = await requireOrg(request);
  const t = tenantOf(ctx.org.id);
  // The name map is cached; every part below waits only on it and on its own query.
  const namesP = serviceNames(t);
  const queryP = namesP.then((names) => buildQuery(service, level, q, showHops ? KindFilter.All : KindFilter.Ordinary, names));
  const ck = (query: string): string => `logs:${t.orgId}:${rangeKey}:${query}`;
  // How many hop records the switch hides, for the same filters, search text and range.
  const hiddenQueryP = namesP.then((names) => `sum(count_over_time(${buildQuery(service, level, q, KindFilter.Hops, names)} [${mins}m]))`);
  return defer({
    services: Promise.all([loki.services(t).catch(() => [] as string[]), namesP]).then(([list, names]) => serviceList(list, names)),
    query: queryP,
    filters: { service, level, q, range: rangeKey, hops: showHops, raw },
    entries: Promise.all([queryP, namesP]).then(([query, names]) =>
      cached(`${ck(query)}:e`, 5000, () => loki.queryRange(query, { start, end, limit: 200 }, t)).then((list) =>
        list.map((e) => ({ ts: e.ts, level: levelName(e.level), service: displayService(e.labels, names), message: stripAnsi(e.message), traceId: traceIdOfLine(e.line) })),
      ),
    ),
    hidden: showHops || raw
      ? Promise.resolve(0)
      : Promise.all([queryP, hiddenQueryP]).then(([query, hq]) => cached(`${ck(query)}:h`, 5000, () => loki.scalar(hq, 0, t))).catch(() => -1),
    volume: queryP.then((query) =>
      cached(`${ck(query)}:v`, 5000, () => loki.countOverTime(`sum(count_over_time(${query} [1m]))`, { start, end, step: "60s" }, t)).then((d) => d.map((p) => ({ t: p.t, v: p.v }))),
    ),
  });
}

const SELECT = "h-8 rounded-lg border border-border bg-surface px-3 text-[13px] outline-none focus:border-brand/40";

export default function Logs() {
  const d = useLoaderData<typeof loader>();
  const submit = useSubmit();
  const nav = useNavigation();
  const loading = nav.state === "loading";
  const f = d.filters;
  const [filtersOpen, setFiltersOpen] = useState(false);
  const changed = [f.service !== "all", f.level !== "all", f.range !== DEFAULT_RANGE].filter(Boolean).length;
  const filterText = `${f.service === "all" ? "all services" : f.service} · ${f.level === "all" ? "all levels" : f.level} · last ${f.range}`;

  return (
    <div className="space-y-4 animate-fade-in">
      <PageTitle
        title="Logs"
        sub="Full-text and structured search across every service's log lines. Pick a service and level, or paste raw LogQL."
        growRight
        right={
          <Form method="get" className="flex min-w-0 flex-1 flex-wrap items-center justify-end gap-2">
            <div className="relative min-w-[140px] flex-1 lg:min-w-[280px]">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-faint" />
              <input name="q" defaultValue={f.q} placeholder={'Search text, or LogQL like {service="commerce-api"} |= "timeout"  ·  Enter to run'} className="h-8 w-full rounded-lg border border-border bg-surface pl-9 pr-3 font-mono text-[13px] outline-none placeholder:text-faint focus:border-brand/40" />
            </div>
            {/* below lg: service, level and range fold behind one button so the header stays one row */}
            <button
              type="button"
              onClick={() => setFiltersOpen((o) => !o)}
              aria-expanded={filtersOpen}
              aria-label={`Filters: ${filterText}`}
              title={filterText}
              className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-border bg-surface px-2.5 text-[13px] text-muted hover:text-fg lg:hidden"
            >
              <SlidersHorizontal className="h-3.5 w-3.5" aria-hidden />
              {changed ? <span className="font-medium text-fg">{changed}</span> : null}
            </button>
            <div className={cn("w-full flex-wrap items-center gap-2 lg:flex lg:w-auto", filtersOpen ? "flex" : "hidden")}>
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
            </div>
          </Form>
        }
      />

      <Card>
        <CardHead title="Volume" sub={<Suspense fallback={null}><Await resolve={d.query} errorElement={null}>{(query: string) => <span className="font-mono" title={query}>{query}</span>}</Await></Suspense>} />
        <Deferred resolve={d.volume} fallback={<ChartSkeleton height={80} />}>
          {(points) => <div className="p-3"><AreaSeries points={points} color="oklch(0.58 0.13 240)" height={80} fmt={(n) => fmtNum(n, 0)} /></div>}
        </Deferred>
      </Card>

      <Card>
        <CardHead title="Lines" sub="newest first · up to 200 shown" right={f.raw ? null : <HopSwitch on={f.hops} filters={f} hidden={d.hidden} />} />
        <Deferred resolve={d.entries} fallback={<RowsSkeleton rows={10} />}>
          {(entries) =>
            entries.length === 0 ? (
              <NoLines filters={f} hidden={d.hidden} />
            ) : (
              <div className={cn("max-h-[62vh] overflow-auto scroll-thin text-[12.5px] leading-[1.7] transition-opacity", loading && "opacity-50")}>
                <div className="sticky top-0 z-[1] hidden grid-cols-[104px_160px_48px_minmax(0,1fr)_auto] gap-3 border-b border-border bg-surface px-4 py-[7px] text-2xs font-medium uppercase tracking-wide text-faint md:grid">
                  <span>Time</span><span>Service</span><span>Level</span><span>Message</span><span className="text-right">Request</span>
                </div>
                {entries.map((e, i) => (
                  <div key={i} className="grid grid-cols-[auto_auto_minmax(0,1fr)] items-baseline gap-x-2 border-b border-border/40 px-3 py-1 font-mono hover:bg-surface-2/50 sm:px-4 md:grid-cols-[104px_160px_48px_minmax(0,1fr)_auto] md:gap-x-3">
                    <span className="shrink-0 tabular-nums text-faint md:col-start-1 md:row-start-1"><Clock ts={e.ts} /></span>
                    <span className={cn("w-9 shrink-0 font-semibold uppercase md:order-none md:w-auto", LEVEL_TEXT[e.level] || "text-faint", "md:col-start-3 md:row-start-1")}>{e.level}</span>
                    <span className="truncate text-accent max-md:text-right md:col-start-2 md:row-start-1" title={e.service}>{e.service}</span>
                    <span className="col-span-3 min-w-0 whitespace-pre-wrap break-words text-fg/90 md:col-span-1 md:col-start-4 md:row-start-1">{e.message}</span>
                    <span className="col-span-3 md:col-span-1 md:col-start-5 md:row-start-1 md:text-right">
                      {e.traceId ? (
                        <Link
                          to={`/requests/${e.traceId}`}
                          className="inline-flex items-center gap-[5px] rounded-[5px] border border-brand/30 px-1.5 py-px text-2xs font-medium text-brand hover:bg-brand/10"
                          title={`Open request ${e.traceId}`}
                        >
                          <GitBranch className="h-3 w-3" />{e.traceId.slice(0, 8)}
                        </Link>
                      ) : <span className="hidden font-sans text-2xs text-faint md:inline">no ID</span>}
                    </span>
                  </div>
                ))}
                {entries.length >= 200 ? <div className="border-t border-border/40 px-4 py-1.5 text-2xs text-faint">Showing the newest 200 lines. Narrow by service, level, or time range to see more.</div> : null}
              </div>
            )
          }
        </Deferred>
      </Card>
    </div>
  );
}

type Filters = { service: string; level: string; q: string; range: string; hops: boolean; raw: boolean };

function hopsHref(filters: Filters, on: boolean): string {
  const params = new URLSearchParams();
  if (filters.q) params.set("q", filters.q);
  if (filters.service !== "all") params.set("service", filters.service);
  if (filters.level !== "all") params.set("level", filters.level);
  params.set("range", filters.range);
  if (on) params.set("hops", "1");
  return `?${params.toString()}`;
}

/** An honest empty state: when only hop records match, say so and offer the switch. */
function NoLines({ filters, hidden }: { filters: Filters; hidden: Promise<number> }) {
  const plain = <Empty icon={<Search className="h-5 w-5" />} title="No log lines match">Widen the time range, clear the filters, or check the query.</Empty>;
  if (filters.hops || filters.raw) return plain;
  return (
    <Suspense fallback={plain}>
      <Await resolve={hidden} errorElement={plain}>
        {(n: number) =>
          n > 0 ? (
            <Empty
              icon={<Search className="h-5 w-5" />}
              title="No ordinary log lines match"
              cta={<Link to={hopsHref(filters, true)} preventScrollReset className="inline-flex h-8 items-center rounded-lg border border-border px-3 text-[12.5px] font-medium hover:bg-surface-2">{n === 1 ? "Show the hop record" : `Show the ${fmtNum(n, 0)} hop records`}</Link>}
            >
              {fmtNum(n, 0)} hop {n === 1 ? "record matches" : "records match"} these filters. Hop records are hidden unless "Show hop records" is on.
            </Empty>
          ) : (
            plain
          )
        }
      </Await>
    </Suspense>
  );
}

/** "Show hop records": a link that flips the URL, so it works before JavaScript loads. */
function HopSwitch({ on, filters, hidden }: { on: boolean; filters: Filters; hidden: Promise<number> }) {
  return (
    <Link
      to={hopsHref(filters, !on)}
      role="switch"
      aria-checked={on}
      preventScrollReset
      className="inline-flex items-center gap-2 text-[12.5px] text-muted hover:text-fg"
    >
      <span className={cn("inline-flex h-[18px] w-[30px] rounded-full p-0.5 transition-colors", on ? "justify-end bg-fg" : "bg-border-strong")}>
        <i className="h-3.5 w-3.5 rounded-full bg-bg" />
      </span>
      Show hop records
      {on ? null : (
        <Suspense fallback={null}>
          <Await resolve={hidden} errorElement={null}>
            {(n: number) => (n > 0 ? <span className="text-2xs text-faint">{fmtNum(n, 0)} hidden</span> : null)}
          </Await>
        </Suspense>
      )}
    </Link>
  );
}
