import type { LoaderFunctionArgs, MetaFunction } from "@remix-run/node";
import { defer } from "@remix-run/node";
import { Link, useLoaderData } from "@remix-run/react";
import { ArrowLeft } from "lucide-react";
import { Card, CardHead, PageTitle } from "~/components/ui";
import { Deferred, RowsSkeleton } from "~/components/defer";
import { formatMoney } from "~/components/site/plans";
import { requireOrg } from "~/lib/auth/context.server";
import { safe } from "~/lib/config.server";
import { loadUsageView, type UsageView } from "~/lib/plans/usage-view.server";
import { cn, fmtBytes } from "~/lib/utils";

export const meta: MetaFunction = () => [{ title: "Usage · backwork" }];

export async function loader({ request }: LoaderFunctionArgs) {
  const ctx = await requireOrg(request);
  return defer({ usage: safe(() => loadUsageView(ctx.org.id), null) });
}

const MONTH = new Intl.DateTimeFormat("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });
const DAY = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long", timeZone: "UTC" });
const SHORT_DAY = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
const at = (day: string): Date => new Date(`${day}T00:00:00Z`);
const count = (n: number): string => n.toLocaleString("en-GB");
const bytes = (n: number): string => (n === 0 ? "0 B" : fmtBytes(n));

export default function Usage() {
  const d = useLoaderData<typeof loader>();
  return (
    <div className="space-y-5 animate-fade-in">
      <PageTitle
        title="Usage"
        sub="What backwork received from your services this calendar month (UTC), against what your plan includes."
        right={
          <Link to="/billing" className="inline-flex items-center gap-1 text-[13px] text-brand hover:underline">
            <ArrowLeft className="h-3.5 w-3.5" /> Billing
          </Link>
        }
      />
      <Deferred resolve={d.usage} fallback={<RowsSkeleton rows={4} />}>
        {(p) =>
          p.error ? (
            <Card><p className="px-4 py-3 text-[13px] text-warn">Usage could not be loaded just now. Reload the page to try again.</p></Card>
          ) : p.data ? (
            <UsagePanels u={p.data} />
          ) : (
            <Card>
              <p className="px-4 py-3 text-[13px] text-muted">Collection is not metered for this organisation, so there is no usage to show.</p>
            </Card>
          )
        }
      </Deferred>
    </div>
  );
}

function Meter({ label, used, limit, show, over }: { label: string; used: number; limit: number | null; show: (n: number) => string; over: "warn" | "err" }) {
  const pct = limit ? Math.min(100, (used / limit) * 100) : 0;
  const tone = used > (limit ?? Infinity) ? (over === "warn" ? "bg-warn" : "bg-err") : pct >= 80 ? "bg-warn" : "bg-brand";
  return (
    <li className="px-4 py-3">
      <div className="flex items-baseline justify-between gap-3 text-[13px]">
        <span className="text-muted">{label}</span>
        <span className="font-mono tabular-nums">{show(used)}{limit ? <span className="text-faint"> of {show(limit)}</span> : null}</span>
      </div>
      {limit ? (
        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-surface-2" role="progressbar" aria-label={label} aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100}>
          <div className={cn("h-full rounded-full", tone)} style={{ width: `${pct}%` }} />
        </div>
      ) : null}
    </li>
  );
}

function UsagePanels({ u }: { u: UsageView }) {
  const { month } = u;
  const monthName = MONTH.format(at(month.first));
  const started = u.firstCounted !== null && u.firstCounted > month.first && u.firstCounted <= month.today ? u.firstCounted : null;
  const quiet = month.requests === 0 && month.bytes === 0;
  return (
    <>
      <Card>
        <CardHead
          title={monthName}
          sub={`${u.planName} plan · 1 to ${DAY.format(at(month.today))}`}
          right={u.included ? <Link to="/billing" className="text-[13px] text-brand hover:underline">Plans</Link> : undefined}
        />
        <ul className="divide-y divide-border">
          <Meter label="Traced requests received" used={month.requests} limit={u.included?.requests ?? null} show={count} over="warn" />
          <Meter label="Data received" used={month.bytes} limit={u.included?.bytes ?? null} show={bytes} over="warn" />
          {u.extra ? (
            <li className="flex flex-wrap items-baseline justify-between gap-x-3 px-4 py-3 text-[13px]">
              <span className="text-muted">{u.extra.cost > 0 ? "Beyond your allowance so far" : "Beyond your allowance"}</span>
              {u.extra.cost > 0 ? (
                <span className="font-mono tabular-nums">
                  about {formatMoney(u.extra.cost)} <span className="text-faint">· {u.extra.breakdown}</span>
                </span>
              ) : (
                <span className="text-muted">Nothing yet</span>
              )}
            </li>
          ) : null}
        </ul>
        {u.extra ? (
          <p className="border-t border-border px-4 py-2.5 text-2xs text-faint">
            An estimate at the rates on the pricing page. Requests and data are counted as they arrive, so the figure moves through the month.
          </p>
        ) : null}
      </Card>

      {u.rolling && u.held ? (
        <Card>
          <CardHead title="Held now" sub="the newest data your plan keeps; the oldest is dropped as new arrives" />
          <ul className="divide-y divide-border">
            <Meter label="Traced requests held" used={u.held.requests.held} limit={u.held.requests.cap} show={count} over="err" />
            <Meter label="Stored data held" used={u.held.bytes.held} limit={u.held.bytes.cap} show={bytes} over="err" />
          </ul>
        </Card>
      ) : null}

      <Card>
        <CardHead title="Each day" sub="traced requests received, UTC" />
        {quiet ? (
          <p className="px-4 py-6 text-center text-[13px] text-muted">Nothing counted yet this month. Figures appear here as your services send data.</p>
        ) : (
          <DayBars days={month.days} today={month.today} />
        )}
        {started ? (
          <p className="border-t border-border px-4 py-2.5 text-2xs text-faint">
            The first data was counted on {DAY.format(at(started))}; days before it show nothing.
          </p>
        ) : null}
      </Card>
    </>
  );
}

/** One bar per day of the month. Days after today stay empty so the month's length is visible. */
function DayBars({ days, today }: { days: UsageView["month"]["days"]; today: string }) {
  const peak = Math.max(1, ...days.map((d) => d.requests));
  const W = 100 / days.length;
  const mid = days[Math.floor(days.length / 2)];
  return (
    <div className="px-4 pb-3 pt-4">
      <svg viewBox="0 0 100 40" preserveAspectRatio="none" className="h-40 w-full" role="img" aria-label={`Traced requests received each day, highest ${count(peak)}`}>
        <line x1="0" y1="39.5" x2="100" y2="39.5" className="stroke-border" strokeWidth="0.4" vectorEffect="non-scaling-stroke" />
        {days.map((d, i) => {
          const h = d.requests > 0 ? Math.max(0.8, (d.requests / peak) * 38) : 0;
          return (
            <rect key={d.day} x={i * W + W * 0.15} y={39 - h} width={W * 0.7} height={h} rx="0.3" className={d.day === today ? "fill-brand" : "fill-brand/60"}>
              <title>{`${SHORT_DAY.format(at(d.day))}: ${count(d.requests)} requests, ${bytes(d.bytes)}`}</title>
            </rect>
          );
        })}
      </svg>
      <div className="mt-1.5 flex justify-between text-2xs text-faint tabular-nums">
        <span>{SHORT_DAY.format(at(days[0].day))}</span>
        <span>{SHORT_DAY.format(at(mid.day))}</span>
        <span>{SHORT_DAY.format(at(days[days.length - 1].day))}</span>
      </div>
    </div>
  );
}
