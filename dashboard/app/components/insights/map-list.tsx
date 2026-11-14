// Service map as a table (BAC-76): every edge, grouped by caller. Always shown on a phone, by
// toggle on desktop, and the accessible form of the graph.
import { NUM, TD, TH, errorTone, fmtRate, fmtShare } from "~/components/services-table";
import { latencyText, nodeTag } from "~/components/insights/map-graph";
import { listRows, type ServiceMap } from "~/lib/hops/service-map";
import { cn } from "~/lib/utils";

export function MapList({ map }: { map: ServiceMap }) {
  const nodes = new Map(map.nodes.map((n) => [n.id, n]));
  const rows = listRows(map);
  return (
    <div className="overflow-x-auto">
      <table data-map-list className="w-full text-[13px]">
        <thead>
          <tr>
            <th className={TH}>From</th>
            <th className={TH}>To</th>
            <th className={cn(TH, "text-right")}>Calls/s</th>
            <th className={cn(TH, "text-right")}>Errors</th>
            <th className={cn(TH, "text-right")}>p95</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((e, i) => {
            const from = nodes.get(e.from);
            const to = nodes.get(e.to);
            const first = i === 0 || rows[i - 1].from !== e.from;
            const tag = to ? nodeTag(to) : null;
            return (
              <tr key={e.id} data-edge={e.id} className="[&:last-child>td]:border-b-0">
                <td className={cn(TD, "max-w-[9rem] truncate", !first && "text-transparent")} title={from?.label}>
                  {from?.label ?? e.from}
                </td>
                <td className={cn(TD, "max-w-[12rem]")}>
                  <span className="flex min-w-0 items-baseline gap-1.5">
                    <span className="min-w-0 truncate" title={to?.label}>{to?.label ?? e.to}</span>
                    {tag ? <span className="shrink-0 text-2xs uppercase tracking-wide text-faint">{tag}</span> : null}
                  </span>
                </td>
                <td className={cn(TD, NUM)}>{fmtRate(e.figures.rate)}</td>
                <td className={cn(TD, NUM, errorTone(e.figures.errorShare))}>{fmtShare(e.figures.errorShare)}</td>
                <td className={cn(TD, NUM)}>{latencyText(e.figures.p95)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
