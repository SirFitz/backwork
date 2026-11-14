// The Performance page's Trend card (BAC-73, insights plan 06 section C): p95 of the selected
// service over the range, last week's same hours dashed, and reported deploys as markers.
import type { ReactNode } from "react";
import { Card, CardHead, ErrorNote } from "~/components/ui";
import { ChartSkeleton, Deferred } from "~/components/defer";
import { TimeSeries, type ChartMarker, type Series } from "~/components/charts";
import { fmtLatency, serviceColor } from "~/components/services-table";
import { markerDetail, markerLabel, type Deploy } from "~/lib/deploys";
import type { PerfRange } from "~/lib/hops/figures";

/** Height of the chart, px; the card keeps it while loading so nothing below moves. */
export const TREND_CHART_HEIGHT_PX = 190;

/** What the loader hands the card, already settled. */
export interface TrendPanel {
  data: {
    service: string | null;
    range: PerfRange;
    now: Array<{ t: number; v: number }>;
    lastWeek: Array<{ t: number; v: number }> | null;
    deploys: Deploy[];
  };
  error: string | null;
}

const LAST_WEEK_COLOR = "oklch(0.62 0.01 260)";

function Legend({ color, lastWeek }: { color: string; lastWeek: boolean }) {
  return (
    <span className="hidden items-center gap-3 text-2xs text-faint sm:inline-flex">
      <span className="inline-flex items-center gap-1.5"><i aria-hidden className="inline-block h-[2px] w-4 rounded" style={{ background: color }} />now</span>
      {lastWeek ? (
        <span className="inline-flex items-center gap-1.5">
          <i aria-hidden className="inline-block h-0 w-4 border-t-2 border-dashed" style={{ borderColor: LAST_WEEK_COLOR }} />last week
        </span>
      ) : null}
      <span className="inline-flex items-center gap-1.5"><i aria-hidden className="inline-block h-3 w-0 border-l border-dotted" style={{ borderColor: LAST_WEEK_COLOR }} />deploy</span>
    </span>
  );
}

function title(service: string | null, range: PerfRange): string {
  return service ? `p95 of ${service}, last ${range}` : `p95, last ${range}`;
}

function Body({ panel }: { panel: TrendPanel }): ReactNode {
  const { service, now, lastWeek, deploys } = panel.data;
  if (panel.error) return <ErrorNote error={panel.error} />;
  if (!service) return <p className="px-4 py-6 text-center text-[13px] text-muted">Pick a service above to see its trend.</p>;
  const color = serviceColor(service);
  const series: Series[] = [{ name: "now", color, points: now.map((p) => ({ t: p.t, v: p.v * 1000 })) }];
  const overlay: Series | undefined = lastWeek ? { name: "last week", color: LAST_WEEK_COLOR, points: lastWeek.map((p) => ({ t: p.t, v: p.v * 1000 })) } : undefined;
  const markers: ChartMarker[] = deploys.map((d) => ({ t: d.deployedAt, label: markerLabel(d), detail: markerDetail(d) }));
  return (
    <div className="p-3">
      <TimeSeries series={series} overlay={overlay} markers={markers} height={TREND_CHART_HEIGHT_PX} fmt={(ms) => fmtLatency(ms / 1000)} />
    </div>
  );
}

export function TrendCard({ resolve, range, compareOffered }: { resolve: Promise<TrendPanel>; range: PerfRange; compareOffered: boolean }) {
  return (
    <Card>
      <Deferred resolve={resolve} fallback={<><CardHead title="Trend" sub={title(null, range)} /><ChartSkeleton height={TREND_CHART_HEIGHT_PX} /></>}>
        {(panel) => (
          <>
            <CardHead
              title="Trend"
              sub={title(panel.data.service, range)}
              subTitle={compareOffered ? "p95 now, the same hours last week dashed, reported deploys as dotted lines" : "p95 now and reported deploys; last week is not drawn on the 7d range"}
              right={<Legend color={panel.data.service ? serviceColor(panel.data.service) : LAST_WEEK_COLOR} lastWeek={panel.data.lastWeek !== null} />}
            />
            <Body panel={panel} />
          </>
        )}
      </Deferred>
    </Card>
  );
}
