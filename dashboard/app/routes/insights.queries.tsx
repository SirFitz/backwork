// Insights > Slow queries (BAC-69): statement shapes ranked by total time, p95 or calls, with the
// routes that call one and a slow example. The page renders at once; the board and an expanded
// row's routes are deferred, each with its own skeleton and error state.
import type { LoaderFunctionArgs, MetaFunction } from "@remix-run/node";
import { defer } from "@remix-run/node";
import { Link, useLoaderData, useNavigate } from "@remix-run/react";
import { Database } from "lucide-react";
import { Deferred } from "~/components/defer";
import { CallingRoutes, CallingRoutesSkeleton, QueryTable, QueryTableSkeleton, rowKey } from "~/components/insights/query-table";
import { Card, CardHead, Empty } from "~/components/ui";
import { requireOrg } from "~/lib/auth/context.server";
import { safe } from "~/lib/config.server";
import {
  QUERY_SORTS,
  QUERY_SORT_LABEL,
  QuerySort,
  SLOW_WINDOWS,
  SlowWindow,
  isQuerySort,
  isSlowWindow,
  sortQueryRows,
  type QueryRow,
  type StatementRoutes,
} from "~/lib/hops/slow-queries";
import { SLOW_FRESH_MS, routesFor, slowQueries, type SlowQueries } from "~/lib/hops/slow-queries.server";
import { tenantOf } from "~/lib/tenant.server";
import { cn } from "~/lib/utils";

export const meta: MetaFunction = () => [{ title: "Slow queries · Insights · backwork" }];

/** Search parameters of the page. */
const Param = { Window: "window", Sort: "sort", Service: "service", Open: "open" } as const;

const WINDOW_LABEL: Record<SlowWindow, string> = { [SlowWindow.H1]: "1 h", [SlowWindow.H6]: "6 h" };
const WINDOW_PHRASE: Record<SlowWindow, string> = { [SlowWindow.H1]: "last hour", [SlowWindow.H6]: "last 6 hours" };
const ALL_SERVICES = "";

interface Panel<T> {
  data: T;
  error: string | null;
}

interface PageState {
  window: SlowWindow;
  sort: QuerySort;
  service: string;
  open: string | null;
}

function stateFrom(url: URL): PageState {
  const w = url.searchParams.get(Param.Window);
  const s = url.searchParams.get(Param.Sort);
  return {
    window: isSlowWindow(w) ? w : SlowWindow.H1,
    sort: isQuerySort(s) ? s : QuerySort.Total,
    service: url.searchParams.get(Param.Service) ?? ALL_SERVICES,
    open: url.searchParams.get(Param.Open),
  };
}

function pageHref(state: PageState): string {
  const p = new URLSearchParams();
  if (state.window !== SlowWindow.H1) p.set(Param.Window, state.window);
  if (state.sort !== QuerySort.Total) p.set(Param.Sort, state.sort);
  if (state.service) p.set(Param.Service, state.service);
  if (state.open) p.set(Param.Open, state.open);
  const q = p.toString();
  return q ? `/insights/queries?${q}` : "/insights/queries";
}

export async function loader({ request }: LoaderFunctionArgs) {
  const ctx = await requireOrg(request);
  const tenant = tenantOf(ctx.org.id);
  const state = stateFrom(new URL(request.url));
  const boardP = slowQueries(tenant, state.window);
  const board: Promise<Panel<SlowQueries | null>> = safe(() => boardP, null);
  const routes: Promise<Panel<StatementRoutes | null>> | null = state.open
    ? safe(async () => {
        const found = (await boardP).rows.find((r) => rowKey(r) === state.open);
        return found ? routesFor(tenant, found, state.window) : null;
      }, null)
    : null;
  return defer({ ...state, now: Date.now(), board, routes });
}

function clockUtc(ms: number): string {
  return `${new Date(ms).toISOString().slice(11, 16)} UTC`;
}

function minutesAgo(fromMs: number, nowMs: number): string {
  const m = Math.max(1, Math.round((nowMs - fromMs) / 60_000));
  return m === 1 ? "from 1 minute ago" : `from ${m} minutes ago`;
}

export default function SlowQueriesPage() {
  const d = useLoaderData<typeof loader>();
  const navigate = useNavigate();
  const state: PageState = { window: d.window, sort: d.sort, service: d.service, open: d.open };
  const go = (next: Partial<PageState>) => navigate(pageHref({ ...state, open: null, ...next }), { preventScrollReset: true, replace: true });

  const controls = (
    <div className="flex items-center gap-1.5">
      <Deferred resolve={d.board} fallback={<ServiceSelect services={[]} value={state.service} onChange={() => {}} disabled />}>
        {(panel) => (
          <ServiceSelect
            services={[...new Set((panel.data?.rows ?? []).map((r) => r.service))].sort()}
            value={state.service}
            onChange={(service) => go({ service })}
          />
        )}
      </Deferred>
      <nav aria-label="Window" className="inline-flex h-7 shrink-0 items-center gap-0.5 rounded-lg border border-border bg-surface p-[3px] text-xs text-muted">
        {SLOW_WINDOWS.map((w) => (
          <Link
            key={w}
            to={pageHref({ ...state, window: w, open: null })}
            preventScrollReset
            replace
            aria-current={w === state.window ? "true" : undefined}
            className={cn("whitespace-nowrap rounded-[5px] px-2 py-0.5 font-medium", w === state.window ? "bg-surface-2 text-fg" : "hover:text-fg")}
          >
            {WINDOW_LABEL[w]}
          </Link>
        ))}
      </nav>
      <select
        aria-label="Sort by"
        value={state.sort}
        onChange={(e) => go({ sort: isQuerySort(e.currentTarget.value) ? e.currentTarget.value : QuerySort.Total })}
        className="h-7 rounded-lg border border-border bg-surface px-1.5 text-xs text-fg outline-none focus:border-brand/40"
      >
        {QUERY_SORTS.map((s) => <option key={s} value={s}>{QUERY_SORT_LABEL[s]}</option>)}
      </select>
    </div>
  );

  return (
    <Card>
      <CardHead
        title="Queries"
        sub={
          <span className="hidden sm:inline">
            <Deferred resolve={d.board} fallback={WINDOW_PHRASE[state.window]}>
              {(panel) => <BoardMeta board={panel.data} window={state.window} now={d.now} />}
            </Deferred>
          </span>
        }
        right={controls}
      />
      <Deferred resolve={d.board} fallback={<QueryTableSkeleton />}>
        {(panel) => (
          <BoardBody
            panel={panel}
            state={state}
            retryHref={pageHref(state)}
            detail={() =>
              d.routes ? (
                <Deferred resolve={d.routes} fallback={<CallingRoutesSkeleton />}>
                  {(r) =>
                    r.error ? (
                      <p className="text-xs text-warn">The routes could not be read: {r.error.slice(0, 160)}</p>
                    ) : r.data ? (
                      <CallingRoutes routes={r.data} />
                    ) : null
                  }
                </Deferred>
              ) : null
            }
          />
        )}
      </Deferred>
    </Card>
  );
}

function ServiceSelect({ services, value, onChange, disabled = false }: { services: readonly string[]; value: string; onChange: (service: string) => void; disabled?: boolean }) {
  const options = value && !services.includes(value) ? [...services, value] : services;
  return (
    <select
      aria-label="Service"
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.currentTarget.value)}
      className="h-7 max-w-[7.5rem] truncate rounded-lg border border-border bg-surface px-1.5 text-xs text-fg outline-none focus:border-brand/40 sm:max-w-[11rem]"
    >
      <option value={ALL_SERVICES}>All services</option>
      {options.map((s) => <option key={s} value={s}>{s}</option>)}
    </select>
  );
}

function BoardMeta({ board, window, now }: { board: SlowQueries | null; window: SlowWindow; now: number }) {
  if (!board) return <>{WINDOW_PHRASE[window]}</>;
  const stale = now - board.computedAt > SLOW_FRESH_MS;
  return (
    <>
      {WINDOW_PHRASE[window]}, as of {clockUtc(board.computedAt)}
      {stale ? <span className="text-muted">, {minutesAgo(board.computedAt, now)}</span> : null}
    </>
  );
}

function BoardBody({
  panel,
  state,
  retryHref,
  detail,
}: {
  panel: Panel<SlowQueries | null>;
  state: PageState;
  retryHref: string;
  detail: (row: QueryRow) => JSX.Element | null;
}) {
  if (panel.error || !panel.data) {
    return (
      <div className="px-4 py-10 text-center text-[13px]">
        <p className="text-warn">The query figures could not be read from the log store{panel.error ? `: ${panel.error.slice(0, 160)}` : "."}</p>
        <Link to={retryHref} replace preventScrollReset reloadDocument className="mt-2 inline-block text-xs font-medium text-brand hover:underline">Retry</Link>
      </div>
    );
  }
  const board = panel.data;
  const shown = sortQueryRows(state.service ? board.rows.filter((r) => r.service === state.service) : board.rows, state.sort);
  if (shown.length === 0) {
    return board.statementsOff ? (
      <Empty icon={<Database className="h-5 w-5" />} title="Query text is switched off for this organisation, so queries are not recorded.">
        Turn it on in <Link to="/settings" className="text-brand hover:underline">Settings</Link>.
      </Empty>
    ) : (
      <Empty icon={<Database className="h-5 w-5" />} title={`No database queries recorded in the ${WINDOW_PHRASE[state.window]}.`} />
    );
  }
  return (
    <>
      {board.groupLimited ? <p className="border-b border-border px-4 py-1.5 text-2xs text-muted">Showing the 200 queries that took the most time.</p> : null}
      <QueryTable
        rows={shown}
        openKey={state.open}
        hrefFor={(row, open) => pageHref({ ...state, open: open ? rowKey(row) : null })}
        detail={detail}
      />
    </>
  );
}
