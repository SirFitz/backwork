// Insights > Fix first (BAC-74): one ranked list of what cost the most time in the window, whatever
// kind it is (route, slow query, repeated query, regression), so the first thing to fix is on top.
// The page renders at once; the list is one deferred promise (so the order never reshuffles as
// sources answer), served from a stale-while-revalidate cache.
import { useState } from "react";
import type { LoaderFunctionArgs, MetaFunction } from "@remix-run/node";
import { defer } from "@remix-run/node";
import { Link, useLoaderData } from "@remix-run/react";
import { Card, CardHead } from "~/components/ui";
import { Deferred } from "~/components/defer";
import { FixList, FixListSkeleton, SourceNotes } from "~/components/insights/fix-list";
import { requireOrg } from "~/lib/auth/context.server";
import { safe } from "~/lib/config.server";
import { tenantOf } from "~/lib/tenant.server";
import { fixFirst, type FixFirstResult } from "~/lib/insights/fix-first.server";
import {
  DEFAULT_FIX_WINDOW,
  FIX_FRESH_MS,
  FIX_KINDS,
  FIX_KIND_FILTER_LABEL,
  FIX_PAGE_ROWS,
  FIX_WINDOWS,
  FIX_WINDOW_LABEL,
  FIX_WINDOW_PHRASE,
  filterFixItems,
  isFixKind,
  isFixWindow,
  type FixKind,
  type FixWindow,
} from "~/lib/insights/fix-first";
import { cn } from "~/lib/utils";

export const meta: MetaFunction = () => [{ title: "Fix first · Insights · backwork" }];

/** Search parameter of the page. */
const WINDOW_PARAM = "window";
const ALL_KINDS = "all";

export async function loader({ request }: LoaderFunctionArgs) {
  const ctx = await requireOrg(request);
  const w = new URL(request.url).searchParams.get(WINDOW_PARAM);
  const window: FixWindow = isFixWindow(w) ? w : DEFAULT_FIX_WINDOW;
  const list: Promise<{ data: FixFirstResult | null; error: string | null }> = safe(() => fixFirst(tenantOf(ctx.org.id), window), null);
  return defer({ window, now: Date.now(), list });
}

function windowHref(w: FixWindow): string {
  return w === DEFAULT_FIX_WINDOW ? "/insights" : `/insights?${WINDOW_PARAM}=${w}`;
}

function clockUtc(ms: number): string {
  return `${new Date(ms).toISOString().slice(11, 16)} UTC`;
}

function minutesAgo(fromMs: number, nowMs: number): string {
  const m = Math.max(1, Math.round((nowMs - fromMs) / 60_000));
  return m === 1 ? "from 1 minute ago" : `from ${m} minutes ago`;
}

function Meta({ result, window, now }: { result: FixFirstResult | null; window: FixWindow; now: number }) {
  if (!result) return <>{FIX_WINDOW_PHRASE[window]}</>;
  const stale = now - result.computedAt > FIX_FRESH_MS;
  return (
    <>
      {FIX_WINDOW_PHRASE[window]}, as of {clockUtc(result.computedAt)}
      {stale ? <span className="text-muted">, {minutesAgo(result.computedAt, now)}</span> : null}
    </>
  );
}

function KindChips({ kind, onChange }: { kind: FixKind | null; onChange: (k: FixKind | null) => void }) {
  const chip = (active: boolean) =>
    cn("whitespace-nowrap rounded-[5px] px-2 py-0.5 font-medium", active ? "bg-surface-2 text-fg" : "hover:text-fg");
  return (
    <>
      <div role="group" aria-label="Kind" className="hidden h-7 shrink-0 items-center gap-0.5 rounded-lg border border-border bg-surface p-[3px] text-xs text-muted md:inline-flex">
        <button type="button" aria-pressed={kind === null} onClick={() => onChange(null)} className={chip(kind === null)}>All</button>
        {FIX_KINDS.map((k) => (
          <button key={k} type="button" aria-pressed={kind === k} onClick={() => onChange(k)} className={chip(kind === k)}>
            {FIX_KIND_FILTER_LABEL[k]}
          </button>
        ))}
      </div>
      <select
        aria-label="Kind"
        value={kind ?? ALL_KINDS}
        onChange={(e) => onChange(isFixKind(e.currentTarget.value) ? e.currentTarget.value : null)}
        className="h-7 max-w-[7.5rem] rounded-lg border border-border bg-surface px-1.5 text-xs text-fg outline-none focus:border-brand/40 md:hidden"
      >
        <option value={ALL_KINDS}>All</option>
        {FIX_KINDS.map((k) => <option key={k} value={k}>{FIX_KIND_FILTER_LABEL[k]}</option>)}
      </select>
    </>
  );
}

function WindowControl({ window }: { window: FixWindow }) {
  return (
    <nav aria-label="Window" className="inline-flex h-7 shrink-0 items-center gap-0.5 rounded-lg border border-border bg-surface p-[3px] text-xs text-muted">
      {FIX_WINDOWS.map((w) => (
        <Link
          key={w}
          to={windowHref(w)}
          preventScrollReset
          replace
          aria-current={w === window ? "true" : undefined}
          className={cn("whitespace-nowrap rounded-[5px] px-2 py-0.5 font-medium", w === window ? "bg-surface-2 text-fg" : "hover:text-fg")}
        >
          {FIX_WINDOW_LABEL[w]}
        </Link>
      ))}
    </nav>
  );
}

export default function FixFirst() {
  const d = useLoaderData<typeof loader>();
  const [kind, setKind] = useState<FixKind | null>(null);
  const [shown, setShown] = useState<number>(FIX_PAGE_ROWS);
  const pick = (k: FixKind | null) => {
    setKind(k);
    setShown(FIX_PAGE_ROWS);
  };
  return (
    <Card>
      <CardHead
        title="What cost the most"
        sub={
          <span className="hidden sm:inline">
            <Deferred resolve={d.list} fallback={FIX_WINDOW_PHRASE[d.window]}>
              {(panel) => <Meta result={panel.data} window={d.window} now={d.now} />}
            </Deferred>
          </span>
        }
        right={
          <div className="flex items-center gap-1.5">
            <KindChips kind={kind} onChange={pick} />
            <WindowControl window={d.window} />
          </div>
        }
      />
      <Deferred resolve={d.list} fallback={<FixListSkeleton />}>
        {(panel) =>
          panel.error || !panel.data ? (
            <div className="px-4 py-10 text-center text-[13px]">
              <p className="text-warn">The list could not be built{panel.error ? `: ${panel.error.slice(0, 160)}` : "."}</p>
              <Link to={windowHref(d.window)} replace preventScrollReset reloadDocument className="mt-2 inline-block text-xs font-medium text-brand hover:underline">Retry</Link>
            </div>
          ) : (
            <>
              <FixList
                items={filterFixItems(panel.data.items, kind)}
                window={d.window}
                shown={shown}
                onMore={() => setShown((n) => n + FIX_PAGE_ROWS)}
                filtered={kind !== null}
              />
              <SourceNotes sources={panel.data.sources} errors={panel.data.errors} repeatsSampled={panel.data.repeatsSampled} />
            </>
          )
        }
      </Deferred>
    </Card>
  );
}
