// The kind-specific fields of the New rule form on /alerts (BAC-72): a service and route for the
// route kinds, a query for slow queries, the threshold with its unit, window, wait and floor.
// Controlled: the draft lives in the page, so the fields can render before the route and query
// lists arrive (`targets` null) without losing what was typed. Pure modules only.
import {
  ANY_SHAPE,
  AlertMetric,
  DEFAULT_MIN_CALLS,
  DEFAULT_MIN_REQUESTS,
  DEFAULT_SLOWNESS_FOR_MINUTES,
  MAX_FOR_MINUTES,
  METRIC_META,
  ROUTE_WINDOWS,
  ROUTE_WINDOW_TEXT,
  isAlertMetric,
  isRouteMetric,
  routeValue,
  shapeValue,
} from "~/lib/alert-kinds";
import type { AlertTargets } from "~/lib/alert-queries";
import { cn } from "~/lib/utils";

export const FIELD = "h-9 w-full rounded-lg border border-border bg-surface px-2.5 text-[13px] outline-none focus:border-brand/40";
const LABEL = "text-2xs font-medium text-muted";
const HINT = "mt-1 block truncate text-2xs font-normal text-faint";

/** The New rule form's values, as the inputs hold them. */
export interface RuleDraft {
  name: string;
  metric: string;
  service: string;
  comparator: string;
  threshold: string;
  route: string;
  window: string;
  minRequests: string;
  shape: string;
  minCalls: string;
  forMinutes: string;
}

export const EMPTY_DRAFT: RuleDraft = {
  name: "",
  metric: AlertMetric.ErrorRate,
  service: "*",
  comparator: ">",
  threshold: "2",
  route: "",
  window: "15m",
  minRequests: "",
  shape: ANY_SHAPE,
  minCalls: "",
  forMinutes: "",
};

/** Sensible starting values when the kind changes. */
export function draftForMetric(d: RuleDraft, metric: string): RuleDraft {
  if (!isAlertMetric(metric)) return { ...d, metric };
  if (metric === AlertMetric.RouteP95) return { ...d, metric, threshold: "500", service: d.service === "*" ? "" : d.service };
  if (metric === AlertMetric.RouteErrorRate) return { ...d, metric, threshold: "5", service: d.service === "*" ? "" : d.service };
  if (metric === AlertMetric.SlowQuery) return { ...d, metric, threshold: "300", service: "*", shape: ANY_SHAPE };
  return { ...d, metric, threshold: "2", service: d.service || "*" };
}

const WINDOW_LABEL: Record<string, string> = { "5m": "5 minutes", "15m": "15 minutes", "1h": "1 hour" };

export function AlertFormFields({
  draft,
  onChange,
  targets,
}: {
  draft: RuleDraft;
  onChange: (next: RuleDraft) => void;
  /** null while the route and query lists load. */
  targets: AlertTargets | null;
}) {
  const set = (patch: Partial<RuleDraft>) => onChange({ ...draft, ...patch });
  const metric = isAlertMetric(draft.metric) ? draft.metric : AlertMetric.ErrorRate;
  const meta = METRIC_META[metric];
  const loading = targets === null;

  if (!isRouteMetric(metric) && metric !== AlertMetric.SlowQuery) {
    return (
      <>
        <label className={cn(LABEL, "lg:col-span-2")}>Service<input name="service" value={draft.service} onChange={(e) => set({ service: e.target.value })} className={cn(FIELD, "mt-1 font-mono")} /></label>
        <label className={cn(LABEL, "lg:col-span-1")}>Op<select name="comparator" value={draft.comparator} onChange={(e) => set({ comparator: e.target.value })} className={cn(FIELD, "mt-1")}><option value=">">&gt;</option><option value="<">&lt;</option></select></label>
        <label className={cn(LABEL, "lg:col-span-1")}>Value<input name="threshold" type="number" step="any" value={draft.threshold} onChange={(e) => set({ threshold: e.target.value })} className={cn(FIELD, "mt-1 font-mono")} /></label>
      </>
    );
  }

  const unit = metric === AlertMetric.RouteErrorRate ? "%" : "ms";
  const wait = (
    <label className={cn(LABEL, "lg:col-span-2")}>
      Wait (minutes)
      <input name="forMinutes" type="number" min={0} max={MAX_FOR_MINUTES} step={1} value={draft.forMinutes} placeholder={String(DEFAULT_SLOWNESS_FOR_MINUTES)} onChange={(e) => set({ forMinutes: e.target.value })} className={cn(FIELD, "mt-1 font-mono")} />
      <span className={HINT}>fires only after this long over the limit</span>
    </label>
  );
  const threshold = (
    <label className={cn(LABEL, "lg:col-span-2")}>
      Limit ({unit})
      <input name="threshold" type="number" min={0} step="any" required value={draft.threshold} onChange={(e) => set({ threshold: e.target.value })} className={cn(FIELD, "mt-1 font-mono")} />
      <span className={HINT} title={meta.hint}>{meta.hint}</span>
    </label>
  );

  if (metric === AlertMetric.SlowQuery) {
    const shapes = targets?.shapes ?? [];
    const selected = draft.shape;
    const known = selected === ANY_SHAPE || shapes.some((s) => shapeValue({ service: s.service, id: s.shapeId }) === selected);
    return (
      <>
        <input type="hidden" name="service" value={draft.service} />
        <label className={cn(LABEL, "min-w-0 lg:col-span-4")}>
          Query
          <select name="shape" value={selected} onChange={(e) => set({ shape: e.target.value })} className={cn(FIELD, "mt-1 font-mono")}>
            <option value={ANY_SHAPE}>Any query (the slowest)</option>
            {!known ? <option value={selected}>{selected}</option> : null}
            {shapes.map((s) => (
              <option key={`${s.service}:${s.shapeId}`} value={shapeValue({ service: s.service, id: s.shapeId })}>
                {s.service}: {s.label}{s.p95Ms !== null ? ` (p95 ${Math.round(s.p95Ms)} ms)` : ""}
              </option>
            ))}
          </select>
          <span className={HINT}>{loading ? "Loading queries" : shapes.length ? "from the slow queries board, last hour" : "No queries recorded in the last hour"}</span>
        </label>
        {threshold}
        {wait}
        <label className={cn(LABEL, "lg:col-span-2")}>
          Minimum calls
          <input name="minCalls" type="number" min={0} step={1} value={draft.minCalls} placeholder={String(DEFAULT_MIN_CALLS)} onChange={(e) => set({ minCalls: e.target.value })} className={cn(FIELD, "mt-1 font-mono")} />
          <span className={HINT}>in the last hour, or no data</span>
        </label>
      </>
    );
  }

  const routes = targets?.routes ?? [];
  const services = [...new Set(routes.map((r) => r.service))];
  if (draft.service && !services.includes(draft.service)) services.unshift(draft.service);
  const serviceRoutes = routes.filter((r) => r.service === draft.service);
  const routeKnown = draft.route === "" || serviceRoutes.some((r) => routeValue(r) === draft.route);
  return (
    <>
      <label className={cn(LABEL, "min-w-0 lg:col-span-2")}>
        Service
        <select name="service" required value={draft.service} onChange={(e) => set({ service: e.target.value, route: "" })} className={cn(FIELD, "mt-1 font-mono")}>
          <option value="" disabled>{loading ? "Loading" : "Pick a service"}</option>
          {services.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
      </label>
      <label className={cn(LABEL, "min-w-0 lg:col-span-3")}>
        Route
        <select name="route" required value={draft.route} onChange={(e) => set({ route: e.target.value })} disabled={!draft.service} className={cn(FIELD, "mt-1 font-mono")}>
          <option value="" disabled>{loading ? "Loading" : draft.service ? "Pick a route" : "Pick a service first"}</option>
          {!routeKnown ? <option value={draft.route}>{draft.route.trim()}</option> : null}
          {serviceRoutes.map((r) => <option key={routeValue(r)} value={routeValue(r)}>{r.method ? `${r.method} ${r.op}` : r.op}</option>)}
        </select>
        <span className={HINT}>routes with traffic in the last 24 hours</span>
      </label>
      {threshold}
      <label className={cn(LABEL, "lg:col-span-2")}>
        Window
        <select name="window" value={draft.window} onChange={(e) => set({ window: e.target.value })} className={cn(FIELD, "mt-1")}>
          {ROUTE_WINDOWS.map((w) => <option key={w} value={w}>{WINDOW_LABEL[w] ?? w}</option>)}
        </select>
        <span className={HINT} title={`read over ${ROUTE_WINDOW_TEXT["15m"]} by default`}>shorter windows are noisy</span>
      </label>
      {wait}
      <label className={cn(LABEL, "lg:col-span-2")}>
        Minimum requests
        <input name="minRequests" type="number" min={0} step={1} value={draft.minRequests} placeholder={String(DEFAULT_MIN_REQUESTS)} onChange={(e) => set({ minRequests: e.target.value })} className={cn(FIELD, "mt-1 font-mono")} />
        <span className={HINT}>in the window, or no data</span>
      </label>
    </>
  );
}
