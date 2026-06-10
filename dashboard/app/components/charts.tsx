import { useEffect, useState } from "react";
import { useTheme } from "remix-themes";
import {
  Area,
  AreaChart,
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

/** Read theme-dependent chart colors from the CSS vars, recompute on toggle. */
function useChartTheme() {
  const [theme] = useTheme();
  const [c, setC] = useState({ grid: "rgba(120,120,120,0.15)", axis: "#9aa0aa" });
  useEffect(() => {
    const root = document.documentElement;
    const get = (v: string) => getComputedStyle(root).getPropertyValue(v).trim();
    const border = get("--border");
    const faint = get("--faint");
    setC({
      grid: border ? `oklch(${border} / 0.6)` : "rgba(120,120,120,0.15)",
      axis: faint ? `oklch(${faint})` : "#9aa0aa",
    });
  }, [theme]);
  return c;
}

// Categorical series palette. Brand coral is intentionally NOT first — it should
// not auto-attach to "the primary series", and it sits ~9° from --err (red), so
// it's pushed to the end to avoid coral/red confusion in multi-series charts.
export const PALETTE = [
  "oklch(0.58 0.13 240)", // blue
  "oklch(0.55 0.17 290)", // violet
  "oklch(0.62 0.1 200)", // teal
  "oklch(0.6 0.13 150)", // green
  "oklch(0.7 0.13 75)", // amber
  "oklch(0.64 0.16 40)", // orange
  "oklch(0.62 0.18 16)", // coral (brand) — last
];

export type Series = { name: string; color: string; points: Array<{ t: number; v: number }> };

function fmtTick(t: number) {
  const d = new Date(t);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function ChartTip({ active, payload, label, unit, fmt }: any) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-lg border border-border bg-surface px-2.5 py-1.5 text-2xs shadow-lg">
      <div className="mb-1 text-faint">{new Date(label).toLocaleTimeString("en-GB", { hour12: false })}</div>
      {payload.map((p: any) => (
        <div key={p.name} className="flex items-center gap-2 font-mono">
          <span className="h-2 w-2 rounded-full" style={{ background: p.color }} />
          <span className="text-fg">{p.name}</span>
          <span className="ml-auto tabular-nums text-fg">{fmt ? fmt(p.value) : Number(p.value).toFixed(2)}{unit || ""}</span>
        </div>
      ))}
    </div>
  );
}

function merge(series: Series[]) {
  const map = new Map<number, Record<string, number>>();
  for (const s of series) for (const p of s.points) {
    const row = map.get(p.t) || { t: p.t };
    row[s.name] = p.v;
    map.set(p.t, row);
  }
  return [...map.values()].sort((a, b) => a.t - b.t);
}

export function TimeSeries({ series, height = 200, unit, fmt }: { series: Series[]; height?: number; unit?: string; fmt?: (n: number) => string }) {
  const hydrated = useHydrated();
  const ct = useChartTheme();
  const data = merge(series);
  if (!hydrated) return <div style={{ height }} className="animate-pulse rounded bg-surface-2/50" />;
  if (!data.length) return <div style={{ height }} className="flex items-center justify-center text-[13px] text-faint">no data in range</div>;
  return (
    <ResponsiveContainer width="100%" height={height}>
      <LineChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: -6 }}>
        <CartesianGrid stroke={ct.grid} vertical={false} />
        <XAxis dataKey="t" tickFormatter={fmtTick} stroke={ct.axis} fontSize={11} tickLine={false} axisLine={{ stroke: ct.grid }} minTickGap={44} />
        <YAxis stroke={ct.axis} fontSize={11} tickLine={false} axisLine={false} width={46} tickFormatter={fmt} />
        <Tooltip content={<ChartTip unit={unit} fmt={fmt} />} />
        {series.map((s) => (
          <Line key={s.name} type="monotone" dataKey={s.name} stroke={s.color} strokeWidth={1.8} dot={false} isAnimationActive={false} connectNulls />
        ))}
      </LineChart>
    </ResponsiveContainer>
  );
}

export function AreaSeries({ points, color = PALETTE[0], height = 120, unit, fmt }: { points: Array<{ t: number; v: number }>; color?: string; height?: number; unit?: string; fmt?: (n: number) => string }) {
  const hydrated = useHydrated();
  const ct = useChartTheme();
  if (!hydrated) return <div style={{ height }} className="animate-pulse rounded bg-surface-2/50" />;
  if (!points.length) return <div style={{ height }} className="flex items-center justify-center text-[13px] text-faint">no data</div>;
  const id = "ar" + color.replace(/[^a-z0-9]/gi, "");
  return (
    <ResponsiveContainer width="100%" height={height}>
      <AreaChart data={points} margin={{ top: 6, right: 10, bottom: 0, left: -6 }}>
        <defs>
          <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity={0.28} />
            <stop offset="100%" stopColor={color} stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid stroke={ct.grid} vertical={false} />
        <XAxis dataKey="t" tickFormatter={fmtTick} stroke={ct.axis} fontSize={11} tickLine={false} axisLine={false} minTickGap={50} />
        <YAxis stroke={ct.axis} fontSize={11} tickLine={false} axisLine={false} width={46} tickFormatter={fmt} />
        <Tooltip content={<ChartTip unit={unit} fmt={fmt} />} />
        <Area type="monotone" dataKey="v" name="value" stroke={color} strokeWidth={1.8} fill={`url(#${id})`} isAnimationActive={false} />
      </AreaChart>
    </ResponsiveContainer>
  );
}
