// Service map graph and its side panel (BAC-76). Plain SVG from the laid-out map in
// `lib/hops/service-map.ts`: nodes are buttons (Tab, Enter), edges too; no animation.
import { useId, type KeyboardEvent, type ReactNode } from "react";
import { Link } from "@remix-run/react";
import { errorTone, fmtLatency, fmtRate, fmtShare, serviceColor } from "~/components/services-table";
import type { PerfRange } from "~/lib/hops/figures";
import {
  EdgeTone,
  NODE_HEIGHT_PX,
  NODE_WIDTH_PX,
  NodeKind,
  SelectionKind,
  activatesSelection,
  edgeWidthPx,
  neighbourEdges,
  type MapEdge,
  type MapFigures,
  type MapNode,
  type MapSelection,
  type ServiceMap,
} from "~/lib/hops/service-map";
import { Via } from "~/lib/hops/types";
import { cn } from "~/lib/utils";

/** Characters of a node label that fit the box at 13 px. */
export const NODE_LABEL_MAX_CHARS = 24;

const TONE_STROKE: Record<EdgeTone, string> = {
  [EdgeTone.Neutral]: "stroke-border-strong",
  [EdgeTone.Warn]: "stroke-warn",
  [EdgeTone.Err]: "stroke-err",
};
const TONE_FILL: Record<EdgeTone, string> = {
  [EdgeTone.Neutral]: "fill-border-strong",
  [EdgeTone.Warn]: "fill-warn",
  [EdgeTone.Err]: "fill-err",
};

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Latency for a figure, "no sample" when there is none. */
export function latencyText(seconds: number | null): string {
  return seconds === null ? "no sample" : fmtLatency(seconds);
}

/** The small tag naming what a node is when it is not a service. */
export function nodeTag(n: Pick<MapNode, "kind" | "via">): string | null {
  if (n.kind === NodeKind.Store) return n.via === Via.Cache ? "cache" : "database";
  if (n.kind === NodeKind.External) return "external";
  return null;
}

function nodeFiguresText(n: MapNode): string {
  if (!n.figures) return "no inbound calls";
  const unit = n.kind === NodeKind.Service ? "req/s" : "calls/s";
  return `${fmtRate(n.figures.rate)} ${unit} · p95 ${latencyText(n.figures.p95)}`;
}

function edgeTitle(e: MapEdge, from: string, to: string): string {
  return `${from} to ${to}: ${fmtRate(e.figures.rate)} calls/s, ${fmtShare(e.figures.errorShare)} errors, p95 ${latencyText(e.figures.p95)}`;
}

function onKeys(select: () => void): (e: KeyboardEvent<SVGGElement>) => void {
  return (e) => {
    if (!activatesSelection(e.key)) return;
    e.preventDefault();
    select();
  };
}

export function MapGraph({ map, selected, onSelect }: { map: ServiceMap; selected: MapSelection | null; onSelect: (s: MapSelection | null) => void }) {
  const uid = useId().replace(/[^a-zA-Z0-9]/g, "");
  const nodes = map.nodes.filter((n) => !n.hidden);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const edges = map.edges.filter((e) => e.drawn);
  const rates = edges.map((e) => e.figures.rate);
  const minRate = rates.length ? Math.min(...rates) : 0;
  const maxRate = rates.length ? Math.max(...rates) : 0;
  const marker = (tone: EdgeTone): string => `map-arrow-${uid}-${tone}`;
  const isSel = (kind: SelectionKind, id: string): boolean => selected?.kind === kind && selected.id === id;
  const touches = (e: MapEdge): boolean => selected?.kind === SelectionKind.Node && (e.from === selected.id || e.to === selected.id);

  return (
    <svg
      data-map-graph
      viewBox={`0 0 ${map.width} ${map.height}`}
      width="100%"
      role="group"
      aria-label="Service map"
      className="block h-auto max-w-full select-none"
      style={{ minWidth: Math.min(map.width, 640) }}
    >
      <defs>
        {Object.values(EdgeTone).map((tone) => (
          <marker key={tone} id={marker(tone)} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M0 0 L10 5 L0 10 z" className={TONE_FILL[tone]} />
          </marker>
        ))}
      </defs>
      <g>
        {edges.map((e) => {
          const a = byId.get(e.from);
          const b = byId.get(e.to);
          if (!a || !b) return null;
          const x1 = a.x + NODE_WIDTH_PX;
          const y1 = a.y + NODE_HEIGHT_PX / 2;
          const x2 = b.x - 2;
          const y2 = b.y + NODE_HEIGHT_PX / 2;
          const dx = Math.max(40, (x2 - x1) / 2);
          const d = `M${x1} ${y1} C${x1 + dx} ${y1} ${x2 - dx} ${y2} ${x2} ${y2}`;
          const sel = isSel(SelectionKind.Edge, e.id);
          const dim = selected !== null && !sel && !touches(e);
          return (
            <g
              key={e.id}
              data-edge={e.id}
              role="button"
              tabIndex={0}
              aria-pressed={sel}
              aria-label={edgeTitle(e, a.label, b.label)}
              onClick={() => onSelect(sel ? null : { kind: SelectionKind.Edge, id: e.id })}
              onKeyDown={onKeys(() => onSelect(sel ? null : { kind: SelectionKind.Edge, id: e.id }))}
              className={cn("cursor-pointer outline-none [&:focus-visible>path:nth-child(3)]:stroke-brand", dim && "opacity-30")}
            >
              <title>{edgeTitle(e, a.label, b.label)}</title>
              <path d={d} fill="none" stroke="transparent" strokeWidth={14} />
              <path
                d={d}
                fill="none"
                className={TONE_STROKE[e.tone]}
                strokeWidth={edgeWidthPx(e.figures.rate, minRate, maxRate) + (sel ? 1 : 0)}
                strokeDasharray={b.kind === NodeKind.External ? "4 4" : undefined}
                markerEnd={`url(#${marker(e.tone)})`}
              />
              {sel ? (
                <text x={(x1 + x2) / 2} y={(y1 + y2) / 2 - 8} textAnchor="middle" className="fill-fg font-mono text-[11px]">
                  p95 {latencyText(e.figures.p95)}
                </text>
              ) : null}
            </g>
          );
        })}
      </g>
      <g>
        {nodes.map((n) => {
          const sel = isSel(SelectionKind.Node, n.id);
          const tag = nodeTag(n);
          return (
            <g
              key={n.id}
              data-node={n.id}
              data-x={n.x}
              data-y={n.y}
              role="button"
              tabIndex={0}
              aria-pressed={sel}
              aria-label={`${n.label}${tag ? ` (${tag})` : ""}: ${nodeFiguresText(n)}`}
              transform={`translate(${n.x} ${n.y})`}
              onClick={() => onSelect(sel ? null : { kind: SelectionKind.Node, id: n.id })}
              onKeyDown={onKeys(() => onSelect(sel ? null : { kind: SelectionKind.Node, id: n.id }))}
              className="cursor-pointer outline-none [&:focus-visible>rect:first-of-type]:stroke-brand"
            >
              <title>{n.label}</title>
              <rect
                width={NODE_WIDTH_PX}
                height={NODE_HEIGHT_PX}
                rx={8}
                className={cn("fill-surface", sel ? "stroke-brand" : "stroke-border-strong")}
                strokeWidth={sel ? 2 : 1}
                strokeDasharray={n.kind === NodeKind.External ? "3 3" : undefined}
              />
              {n.kind === NodeKind.Service ? <rect x={0} y={8} width={3} height={NODE_HEIGHT_PX - 16} rx={1.5} style={{ fill: serviceColor(n.label) }} /> : null}
              <text x={14} y={23} className="fill-fg text-[13px] font-medium">
                {clip(n.label, tag ? NODE_LABEL_MAX_CHARS - 7 : NODE_LABEL_MAX_CHARS)}
              </text>
              {tag ? (
                <text x={NODE_WIDTH_PX - 10} y={22} textAnchor="end" className="fill-faint text-[10px] uppercase tracking-wide">
                  {tag}
                </text>
              ) : null}
              <text x={14} y={42} className="fill-muted font-mono text-[11px]">
                {nodeFiguresText(n)}
              </text>
            </g>
          );
        })}
      </g>
    </svg>
  );
}

function FigureRows({ figures }: { figures: MapFigures }) {
  const row = (k: string, v: ReactNode, cls = ""): ReactNode => (
    <div className="flex justify-between gap-3 py-1">
      <dt className="text-muted">{k}</dt>
      <dd className={cn("font-mono tabular-nums", cls)}>{v}</dd>
    </div>
  );
  return (
    <dl className="text-[12.5px]">
      {row("Calls/s", fmtRate(figures.rate))}
      {row("Errors", fmtShare(figures.errorShare), errorTone(figures.errorShare))}
      {row("p50", latencyText(figures.p50))}
      {row("p95", latencyText(figures.p95))}
      {row("p99", latencyText(figures.p99))}
    </dl>
  );
}

function EdgeLines({ title, edges, other, labelOf }: { title: string; edges: MapEdge[]; other: (e: MapEdge) => string; labelOf: (id: string) => string }) {
  return (
    <div>
      <h4 className="text-2xs font-medium uppercase tracking-wide text-faint">{title}</h4>
      {edges.length ? (
        <ul className="mt-1 divide-y divide-border">
          {edges.map((e) => (
            <li key={e.id} className="flex items-baseline justify-between gap-2 py-1.5 text-[12.5px]">
              <span className="min-w-0 truncate" title={labelOf(other(e))}>{labelOf(other(e))}</span>
              <span className="shrink-0 font-mono tabular-nums text-muted">
                {fmtRate(e.figures.rate)}/s · <span className={errorTone(e.figures.errorShare)}>{fmtShare(e.figures.errorShare)}</span> · {latencyText(e.figures.p95)}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-1 text-[12.5px] text-muted">None in this range.</p>
      )}
    </div>
  );
}

/** The side panel: what the picked node calls and is called by, or the picked edge's figures. */
export function MapDetails({ map, selected, range }: { map: ServiceMap; selected: MapSelection | null; range: PerfRange }) {
  const label = new Map(map.nodes.map((n) => [n.id, n.label]));
  const labelOf = (id: string): string => label.get(id) ?? id;
  if (!selected) {
    return <p className="p-4 text-[13px] text-muted">Select a service or a link to see its calls.</p>;
  }
  if (selected.kind === SelectionKind.Edge) {
    const e = map.edges.find((x) => x.id === selected.id);
    if (!e) return null;
    const from = map.nodes.find((n) => n.id === e.from);
    return (
      <div className="space-y-3 p-4">
        <h3 className="text-[13px] font-semibold">
          {labelOf(e.from)} to {labelOf(e.to)}
        </h3>
        {e.peers.length ? <p className="text-2xs text-faint">Addressed as {e.peers.join(", ")}</p> : null}
        <FigureRows figures={e.figures} />
        {from?.kind === NodeKind.Service ? (
          <Link to={`/requests?${new URLSearchParams({ service: from.label, range }).toString()}`} className="text-[13px] text-brand hover:underline">
            Requests of {from.label}
          </Link>
        ) : null}
      </div>
    );
  }
  const n = map.nodes.find((x) => x.id === selected.id);
  if (!n) return null;
  const { callers, callees } = neighbourEdges(map, n.id);
  const tag = nodeTag(n);
  return (
    <div className="space-y-4 p-4">
      <div>
        <h3 className="flex items-baseline gap-2 text-[13px] font-semibold">
          <span className="min-w-0 truncate">{n.label}</span>
          {tag ? <span className="text-2xs font-normal uppercase tracking-wide text-faint">{tag}</span> : null}
        </h3>
        <p className="mt-0.5 font-mono text-2xs text-muted">{nodeFiguresText(n)}</p>
        {n.kind === NodeKind.Service && n.peers.length ? (
          <p className="mt-1 text-2xs text-faint">Matched by host name: {n.peers.join(", ")}. Services behind one host show as one.</p>
        ) : null}
      </div>
      <EdgeLines title="Called by" edges={callers} other={(e) => e.from} labelOf={labelOf} />
      <EdgeLines title="Calls" edges={callees} other={(e) => e.to} labelOf={labelOf} />
      {n.kind === NodeKind.Service ? (
        <Link to={`/performance?${new URLSearchParams({ service: n.label, range }).toString()}`} className="inline-block text-[13px] text-brand hover:underline">
          Performance of {n.label}
        </Link>
      ) : null}
    </div>
  );
}
