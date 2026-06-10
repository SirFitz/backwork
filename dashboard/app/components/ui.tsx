import type { ReactNode } from "react";
import { cn } from "~/lib/utils";

export function Card({ className, children }: { className?: string; children: ReactNode }) {
  return <section className={cn("rounded-xl border border-border bg-surface", className)}>{children}</section>;
}

export function CardHead({
  title,
  sub,
  right,
}: {
  title: ReactNode;
  sub?: ReactNode;
  right?: ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
      <div className="min-w-0">
        <h2 className="truncate text-[15px] font-semibold tracking-tight">{title}</h2>
        {sub ? <p className="mt-0.5 truncate text-2xs text-faint">{sub}</p> : null}
      </div>
      {right ? <div className="shrink-0">{right}</div> : null}
    </div>
  );
}

export function PageTitle({ title, sub }: { title: string; sub?: string }) {
  return (
    <div className="mb-5">
      <h1 className="text-[22px] font-semibold tracking-tight">{title}</h1>
      {sub ? <p className="mt-1 max-w-[70ch] text-[13.5px] text-muted">{sub}</p> : null}
    </div>
  );
}

type Status = "up" | "degraded" | "down" | "stopped";
const STATUS: Record<Status, { dot: string; text: string; label: string; ring: string }> = {
  up: { dot: "bg-ok", text: "text-ok", label: "Operational", ring: "ring-ok/30" },
  degraded: { dot: "bg-warn", text: "text-warn", label: "Degraded", ring: "ring-warn/30" },
  down: { dot: "bg-err", text: "text-err", label: "Down", ring: "ring-err/30" },
  stopped: { dot: "bg-faint", text: "text-faint", label: "Stopped", ring: "ring-border" },
};

export function StatusDot({ status, pulse = false }: { status: Status; pulse?: boolean }) {
  const s = STATUS[status];
  return (
    <span className="relative inline-flex h-2 w-2">
      {pulse && status !== "up" ? (
        <span className={cn("absolute inline-flex h-full w-full animate-ping rounded-full opacity-60", s.dot)} />
      ) : null}
      <span className={cn("relative inline-flex h-2 w-2 rounded-full", s.dot)} />
    </span>
  );
}

export function StatusPill({ status }: { status: Status }) {
  const s = STATUS[status];
  return (
    <span className={cn("inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-2xs font-medium ring-1 ring-inset", s.text, s.ring)}>
      <StatusDot status={status} pulse />
      {s.label}
    </span>
  );
}

export function Badge({
  children,
  tone = "neutral",
  className,
}: {
  children: ReactNode;
  tone?: "neutral" | "ok" | "warn" | "err" | "info" | "brand" | "accent";
  className?: string;
}) {
  const tones: Record<string, string> = {
    neutral: "bg-surface-2 text-muted ring-border",
    ok: "bg-ok/10 text-ok ring-ok/25",
    warn: "bg-warn/10 text-warn ring-warn/25",
    err: "bg-err/10 text-err ring-err/25",
    info: "bg-info/10 text-info ring-info/25",
    brand: "bg-brand/10 text-brand ring-brand/25",
    accent: "bg-accent/10 text-accent ring-accent/25",
  };
  return (
    <span className={cn("inline-flex items-center rounded px-1.5 py-0.5 text-2xs font-medium ring-1 ring-inset", tones[tone], className)}>
      {children}
    </span>
  );
}

export function KeyStat({
  label,
  value,
  delta,
  tone,
}: {
  label: string;
  value: ReactNode;
  delta?: ReactNode;
  tone?: string;
}) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-2xs uppercase tracking-wide text-faint">{label}</span>
      <span className={cn("font-mono text-[22px] font-semibold leading-none tabular-nums", tone)}>{value}</span>
      {delta ? <span className="text-2xs text-faint">{delta}</span> : null}
    </div>
  );
}

export function Empty({ icon, title, children, cta }: { icon?: ReactNode; title?: string; children?: ReactNode; cta?: ReactNode }) {
  return (
    <div className="px-4 py-12 text-center">
      {icon ? <div className="mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-xl bg-brand/10 text-brand/70">{icon}</div> : null}
      {title ? <p className="text-sm font-medium text-fg">{title}</p> : null}
      {children ? <p className="mx-auto mt-1 max-w-[48ch] text-[13px] text-muted">{children}</p> : null}
      {cta ? <div className="mt-4 flex flex-wrap items-center justify-center gap-2">{cta}</div> : null}
    </div>
  );
}

export function ErrorNote({ error }: { error?: string | null }) {
  if (!error) return null;
  return (
    <div className="border-b border-warn/20 bg-warn/5 px-4 py-2 text-2xs text-warn">
      data source unavailable — {error.slice(0, 180)}
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn("relative overflow-hidden rounded bg-surface-2", className)} />;
}

/** Lightweight inline SVG sparkline for table rows (no chart lib overhead). */
export function Sparkline({
  data,
  width = 96,
  height = 26,
  color = "currentColor",
  className,
}: {
  data: number[];
  width?: number;
  height?: number;
  color?: string;
  className?: string;
}) {
  if (!data || data.length < 2) return <span className="text-2xs text-faint">—</span>;
  const max = Math.max(...data, 0.0001);
  const min = Math.min(...data, 0);
  const span = max - min || 1;
  const dx = width / (data.length - 1);
  const pts = data.map((v, i) => `${(i * dx).toFixed(1)},${(height - ((v - min) / span) * height).toFixed(1)}`);
  const area = `0,${height} ${pts.join(" ")} ${width},${height}`;
  const id = "sl" + Math.abs(data.reduce((a, v, i) => a + v * (i + 1), 0) | 0);
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className={cn("overflow-visible", className)} style={{ color }} aria-hidden>
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity={0.22} />
          <stop offset="100%" stopColor={color} stopOpacity={0} />
        </linearGradient>
      </defs>
      <polygon points={area} fill={`url(#${id})`} />
      <polyline points={pts.join(" ")} fill="none" stroke={color} strokeWidth={1.4} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

/** Horizontal usage bar (e.g. memory % of limit). */
export function Meter({ value, max = 100, tone }: { value: number; max?: number; tone?: "ok" | "warn" | "err" }) {
  const pct = Math.max(0, Math.min(100, (value / max) * 100));
  const color = tone === "err" ? "bg-err" : tone === "warn" ? "bg-warn" : "bg-ok";
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-2">
      <div className={cn("h-full rounded-full", color)} style={{ width: `${pct}%` }} />
    </div>
  );
}
