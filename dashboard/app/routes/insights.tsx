// Insights (BAC-67): one nav item for the analyses built from stored hop records, with a tab per
// board. A tab is listed only once its route exists: each feature PR flips its `ready` flag.
import type { LoaderFunctionArgs, MetaFunction } from "@remix-run/node";
import { json } from "@remix-run/node";
import { NavLink, Outlet } from "@remix-run/react";
import { InfoTip } from "~/components/ui";
import { requireOrg } from "~/lib/auth/context.server";
import { cn } from "~/lib/utils";

export const meta: MetaFunction = () => [{ title: "Insights · backwork" }];

export async function loader({ request }: LoaderFunctionArgs) {
  await requireOrg(request);
  return json({});
}

/** The boards under Insights, in tab order. */
export const InsightTab = {
  FixFirst: "fix_first",
  SlowQueries: "slow_queries",
  RepeatedCalls: "repeated_calls",
  ServiceMap: "service_map",
} as const;
export type InsightTab = (typeof InsightTab)[keyof typeof InsightTab];

export interface InsightTabDef {
  key: InsightTab;
  label: string;
  to: string;
  /** The tab's route exists. Hidden until its feature lands. */
  ready: boolean;
}

export const INSIGHT_TABS: readonly InsightTabDef[] = [
  { key: InsightTab.FixFirst, label: "Fix first", to: "/insights", ready: true },
  { key: InsightTab.SlowQueries, label: "Slow queries", to: "/insights/queries", ready: true },
  { key: InsightTab.RepeatedCalls, label: "Repeated calls", to: "/insights/repeats", ready: true },
  { key: InsightTab.ServiceMap, label: "Service map", to: "/insights/map", ready: true },
];

/** The tabs to show: only those whose route exists. */
export function visibleInsightTabs(tabs: readonly InsightTabDef[] = INSIGHT_TABS): InsightTabDef[] {
  return tabs.filter((t) => t.ready);
}

function InsightTabs() {
  return (
    <nav aria-label="Insights" className="scroll-thin inline-flex h-8 max-w-full shrink-0 items-center gap-0.5 overflow-x-auto rounded-lg border border-border bg-surface p-[3px] text-xs text-muted">
      {visibleInsightTabs().map((t) => (
        <NavLink
          key={t.key}
          to={t.to}
          end
          prefetch="intent"
          className={({ isActive }) => cn("whitespace-nowrap rounded-[5px] px-[9px] py-1 font-medium", isActive ? "bg-surface-2 text-fg" : "hover:text-fg")}
        >
          {t.label}
        </NavLink>
      ))}
    </nav>
  );
}

/** One row on every width. On a phone the tab strip is the row (the page name is in the bottom bar
 *  and the title stays for screen readers), so the first card sits within 56 px of the header
 *  (UI_ISSUES 4); from `sm` the title and the tabs share the row as on other pages. */
export default function Insights() {
  return (
    <div className="space-y-5 animate-fade-in">
      <div data-page-head className="flex items-center gap-x-4 sm:justify-between">
        <div className="flex min-w-0 items-center gap-1.5">
          <h1 className="sr-only truncate text-[17px] font-semibold leading-6 tracking-tight sm:not-sr-only">Insights</h1>
          <span className="hidden sm:inline-flex">
            <InfoTip text="Where your requests lose time, ranked from the request records backwork already keeps: slow queries, repeated calls and the calls between your services." />
          </span>
        </div>
        <div className="flex min-w-0 flex-1 justify-end sm:flex-none">
          <InsightTabs />
        </div>
      </div>
      <Outlet />
    </div>
  );
}
