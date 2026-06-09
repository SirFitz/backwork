import { useEffect, useState } from "react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

export function useHydrated() {
  const [h, setH] = useState(false);
  useEffect(() => setH(true), []);
  return h;
}

export type Series = { name: string; color: string; points: Array<{ t: number; v: number }> };

const AXIS = { stroke: "#3a4150", fontSize: 11 };
const GRID = "#1c222e";

function fmtTick(t: number) {
  const d = new Date(t);
  return d.getHours().toString().padStart(2, "0") + ":" + d.getMinutes().toString().padStart(2, "0");
}

function ChartTooltip({ active, payload, label, unit }: any) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded border border-border bg-panel-2 px-2.5 py-1.5 text-xs shadow-lg">
      <div className="mb-1 text-muted">{new Date(label).toLocaleTimeString("en-GB", { hour12: false })}</div>
      {payload.map((p: any) => (
        <div key={p.name} className="flex items-center gap-2 font-mono">
          <span className="h-2 w-2 rounded-full" style={{ background: p.color }} />
          <span className="text-fg">{p.name}</span>
          <span className="ml-auto tabular-nums text-fg">{Number(p.value).toFixed(2)}{unit || ""}</span>
        </div>
      ))}
    </div>
  );
}

/** Merge multiple series into a single recharts dataset keyed by timestamp. */
function merge(series: Series[]) {
  const map = new Map<number, Record<string, number>>();
  for (const s of series) {
    for (const p of s.points) {
      const row = map.get(p.t) || { t: p.t };
      row[s.name] = p.v;
      map.set(p.t, row);
    }
  }
  return [...map.values()].sort((a, b) => a.t - b.t);
}

export function TimeSeries({ series, height = 200, unit }: { series: Series[]; height?: number; unit?: string }) {
  const hydrated = useHydrated();
  const data = merge(series);
  if (!hydrated) return <div style={{ height }} className="animate-pulse rounded bg-panel-2/40" />;
  if (!data.length) return <div style={{ height }} className="flex items-center justify-center text-sm text-muted">no data in range</div>;
  return (
    <ResponsiveContainer width="100%" height={height}>
      <LineChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: -8 }}>
        <CartesianGrid stroke={GRID} vertical={false} />
        <XAxis dataKey="t" tickFormatter={fmtTick} {...AXIS} tickLine={false} axisLine={{ stroke: GRID }} minTickGap={40} />
        <YAxis {...AXIS} tickLine={false} axisLine={false} width={44} />
        <Tooltip content={<ChartTooltip unit={unit} />} />
        {series.map((s) => (
          <Line key={s.name} type="monotone" dataKey={s.name} stroke={s.color} strokeWidth={1.8} dot={false} isAnimationActive={false} connectNulls />
        ))}
      </LineChart>
    </ResponsiveContainer>
  );
}

export function AreaSeries({ points, color = "#ef5a78", height = 120, unit }: { points: Array<{ t: number; v: number }>; color?: string; height?: number; unit?: string }) {
  const hydrated = useHydrated();
  if (!hydrated) return <div style={{ height }} className="animate-pulse rounded bg-panel-2/40" />;
  if (!points.length) return <div style={{ height }} className="flex items-center justify-center text-sm text-muted">no data</div>;
  const id = "g" + color.replace(/[^a-z0-9]/gi, "");
  return (
    <ResponsiveContainer width="100%" height={height}>
      <AreaChart data={points} margin={{ top: 6, right: 8, bottom: 0, left: -12 }}>
        <defs>
          <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity={0.4} />
            <stop offset="100%" stopColor={color} stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid stroke={GRID} vertical={false} />
        <XAxis dataKey="t" tickFormatter={fmtTick} {...AXIS} tickLine={false} axisLine={false} minTickGap={50} />
        <YAxis {...AXIS} tickLine={false} axisLine={false} width={40} />
        <Tooltip content={<ChartTooltip unit={unit} />} />
        <Area type="monotone" dataKey="v" name="value" stroke={color} strokeWidth={1.8} fill={`url(#${id})`} isAnimationActive={false} />
      </AreaChart>
    </ResponsiveContainer>
  );
}

export function Bars({ data, color = "#58a6ff", height = 120 }: { data: Array<{ label: string; v: number }>; color?: string; height?: number }) {
  const hydrated = useHydrated();
  if (!hydrated) return <div style={{ height }} className="animate-pulse rounded bg-panel-2/40" />;
  if (!data.length) return <div style={{ height }} className="flex items-center justify-center text-sm text-muted">no data</div>;
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data} margin={{ top: 6, right: 8, bottom: 0, left: -12 }}>
        <CartesianGrid stroke={GRID} vertical={false} />
        <XAxis dataKey="label" {...AXIS} tickLine={false} axisLine={{ stroke: GRID }} />
        <YAxis {...AXIS} tickLine={false} axisLine={false} width={40} />
        <Tooltip content={<ChartTooltip />} cursor={{ fill: "#ffffff08" }} />
        <Bar dataKey="v" name="value" fill={color} radius={[2, 2, 0, 0]} isAnimationActive={false} />
      </BarChart>
    </ResponsiveContainer>
  );
}

export const PALETTE = ["#ef5a78", "#58a6ff", "#3fb950", "#d8a657", "#a371f7", "#56d4dd", "#f0883e"];
