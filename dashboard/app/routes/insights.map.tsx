// Insights > Service map (BAC-76): who calls whom, with rate, errors and p95 on each link,
// including databases, caches and hosts not matched to a service. Graph on desktop, list always
// on a phone and by toggle. The figures load deferred with their own skeleton and error state.
import type { LoaderFunctionArgs } from "@remix-run/node";
import { defer } from "@remix-run/node";
import { Link, useLoaderData, useNavigate, useRevalidator } from "@remix-run/react";
import { useEffect, useRef, useState } from "react";
import { Network } from "lucide-react";
import { Card, CardHead, Empty, InfoTip } from "~/components/ui";
import { ChartSkeleton, Deferred, RowsSkeleton } from "~/components/defer";
import { MapDetails, MapGraph } from "~/components/insights/map-graph";
import { MapList } from "~/components/insights/map-list";
import { requireOrg } from "~/lib/auth/context.server";
import { safe } from "~/lib/config.server";
import { tenantOf } from "~/lib/tenant.server";
import type { PerfRange } from "~/lib/hops/figures";
import { serviceMap, type ServiceMapResult } from "~/lib/hops/service-map.server";
import { MAP_FRESH_MS, MAP_RANGES, parseMapRange } from "~/lib/hops/service-map";
import { MapView, parseMapView, type MapSelection } from "~/lib/hops/service-map";
import { plural } from "~/lib/hops/time-format";
import { withBudget } from "~/lib/with-budget";
import { cn } from "~/lib/utils";

interface MapPanel {
  map: ServiceMapResult | null;
  /** Age of the figures when served, in milliseconds. */
  ageMs: number;
  /** The first computation is still running: the page asks again in a few seconds. */
  building: boolean;
}

/** The first map of an organisation scans recent records and reads several figures; past this the
 *  page shows "building" instead of waiting (Remix gives up on a slow stream after 5 seconds). */
const MAP_BUDGET_MS = 3_500;
/** How often the page asks again while the map is being built, and how many times it tries. */
const BUILD_POLL_MS = 3_000;
const BUILD_POLL_MAX = 10;

export async function loader({ request }: LoaderFunctionArgs) {
  const ctx = await requireOrg(request);
  const tenant = tenantOf(ctx.org.id);
  const url = new URL(request.url);
  const range = parseMapRange(url.searchParams.get("range"));
  const view = parseMapView(url.searchParams.get("view"));
  const panel = safe<MapPanel>(async () => {
    const map = await withBudget(serviceMap(range, tenant), MAP_BUDGET_MS);
    return map ? { map, ageMs: Date.now() - map.computedAt, building: false } : { map: null, ageMs: 0, building: true };
  }, { map: null, ageMs: 0, building: false });
  return defer({ range, view, panel });
}

function mapHref(range: PerfRange, view: MapView): string {
  const p = new URLSearchParams({ range });
  if (view === MapView.List) p.set("view", view);
  return `/insights/map?${p.toString()}`;
}

const SEGMENTS = "inline-flex h-8 shrink-0 items-center gap-0.5 rounded-lg border border-border bg-surface p-[3px] text-xs text-muted";
const segment = (on: boolean): string => cn("rounded-[5px] px-[9px] py-1 font-medium", on ? "bg-surface-2 text-fg" : "hover:text-fg");

function Controls({ range, view }: { range: PerfRange; view: MapView }) {
  const navigate = useNavigate();
  return (
    <div className="flex items-center gap-2">
      <nav aria-label="View" className={cn(SEGMENTS, "hidden md:inline-flex")}>
        {[MapView.Graph, MapView.List].map((v) => (
          <Link key={v} to={mapHref(range, v)} preventScrollReset aria-current={v === view ? "true" : undefined} className={segment(v === view)}>
            {v === MapView.Graph ? "Graph" : "List"}
          </Link>
        ))}
      </nav>
      <select
        aria-label="Range"
        value={range}
        onChange={(e) => navigate(mapHref(parseMapRange(e.currentTarget.value), view), { preventScrollReset: true })}
        className="h-8 rounded-lg border border-border bg-surface px-2 text-[13px] text-fg outline-none focus:border-brand/40 sm:hidden"
      >
        {MAP_RANGES.map((r) => <option key={r} value={r}>{r}</option>)}
      </select>
      <nav aria-label="Range" className={cn(SEGMENTS, "hidden sm:inline-flex")}>
        {MAP_RANGES.map((r) => (
          <Link key={r} to={mapHref(r, view)} preventScrollReset aria-current={r === range ? "true" : undefined} className={segment(r === range)}>
            {r}
          </Link>
        ))}
      </nav>
    </div>
  );
}

function Notes({ map, ageMs }: { map: ServiceMapResult; ageMs: number }) {
  const notes: string[] = [];
  if (map.hiddenNodes > 0) notes.push(`The graph shows the 40 busiest; ${map.hiddenNodes} more ${plural(map.hiddenNodes, "is", "are")} in the list.`);
  if (map.unresolvedPeers > 0) {
    notes.push(`${plural(map.unresolvedPeers, "host", "hosts")} could not be matched to a service. Make sure they report to backwork.`);
  }
  if (map.peersUnavailable) notes.push("Hosts could not be matched to services just now, so some services may show as external.");
  if (ageMs > MAP_FRESH_MS) notes.push(`Figures from about ${Math.max(1, Math.round(ageMs / 60_000))} min ago; newer ones are on the way.`);
  if (!notes.length) return null;
  return (
    <div className="space-y-0.5 border-t border-border px-4 py-2 text-2xs text-muted">
      {notes.map((n) => <p key={n}>{n}</p>)}
    </div>
  );
}

function MapBody({ map, ageMs, view, range }: { map: ServiceMapResult; ageMs: number; view: MapView; range: PerfRange }) {
  const [selected, setSelected] = useState<MapSelection | null>(null);
  if (!map.edges.length) {
    return <Empty icon={<Network className="h-5 w-5" />} title="No calls between services recorded in this range." />;
  }
  return (
    <>
      {view === MapView.Graph ? (
        <div className="hidden md:grid md:grid-cols-[minmax(0,1fr)_320px]">
          <div className="overflow-x-auto p-3">
            <MapGraph map={map} selected={selected} onSelect={setSelected} />
          </div>
          <aside aria-label="Selected" className="border-l border-border">
            <MapDetails map={map} selected={selected} range={range} />
          </aside>
        </div>
      ) : null}
      <div className={view === MapView.Graph ? "md:hidden" : undefined}>
        <MapList map={map} />
      </div>
      <Notes map={map} ageMs={ageMs} />
    </>
  );
}

/** Shown while the first computation runs; asks the loader again until the map is there. */
function Building() {
  const revalidator = useRevalidator();
  const tries = useRef(0);
  const [gaveUp, setGaveUp] = useState(false);
  useEffect(() => {
    if (gaveUp) return;
    const id = setTimeout(() => {
      tries.current += 1;
      if (tries.current >= BUILD_POLL_MAX) setGaveUp(true);
      else revalidator.revalidate();
    }, BUILD_POLL_MS);
    return () => clearTimeout(id);
  });
  return (
    <>
      <RowsSkeleton rows={4} />
      <p className="px-4 pb-4 text-center text-[13px] text-muted">
        {gaveUp ? "The map is still being built. Reload the page in a minute." : "Building the map for the first time. It takes a few seconds and will appear here."}
      </p>
    </>
  );
}

export default function ServiceMapPage() {
  const d = useLoaderData<typeof loader>();
  const range = d.range as PerfRange;
  const view = d.view as MapView;
  const head = (
    <CardHead
      title={
        <span className="flex items-center gap-1.5">
          Service map
          <InfoTip text="Who calls whom, from the outbound call figures: calls per second, error share and p95 on each link. Hosts are matched to services from recent request records." />
        </span>
      }
      sub={`last ${range}`}
      right={<Controls range={range} view={view} />}
    />
  );
  return (
    <Card>
      {head}
      <Deferred
        resolve={d.panel}
        fallback={
          <>
            <div className={view === MapView.Graph ? "hidden md:block" : "hidden"}><ChartSkeleton height={320} /></div>
            <div className={view === MapView.Graph ? "md:hidden" : undefined}><RowsSkeleton rows={6} /></div>
          </>
        }
      >
        {(panel) =>
          panel.data.building ? (
            <Building />
          ) : panel.error || !panel.data.map ? (
            <p className="px-4 py-10 text-center text-[13px] text-err">The figures could not be read: {(panel.error ?? "no data").slice(0, 180)}</p>
          ) : (
            <MapBody map={panel.data.map as ServiceMapResult} ageMs={panel.data.ageMs} view={view} range={range} />
          )
        }
      </Deferred>
    </Card>
  );
}
