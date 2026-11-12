import type { ReactNode } from "react";
import { Info } from "lucide-react";
import { cn } from "~/lib/utils";

export function Card({ className, children }: { className?: string; children: ReactNode }) {
  return <section className={cn("rounded-xl border border-border bg-surface", className)}>{children}</section>;
}

/**
 * A card's header: one row of title, then its meta inline in small muted text (cut with an ellipsis,
 * whole text on hover), then actions on the right. At most 48 px tall (BAC-53, UI_ISSUES 4).
 */
export function CardHead({
  title,
  sub,
  subTitle,
  right,
  className,
}: {
  title: ReactNode;
  sub?: ReactNode;
  /** Hover text for `sub` when it is not a plain string. */
  subTitle?: string;
  right?: ReactNode;
  className?: string;
}) {
  return (
    <div data-card-head className={cn("flex min-h-11 items-center justify-between gap-3 border-b border-border px-4 py-1.5", className)}>
      <CardHeadText title={title} sub={sub} subTitle={subTitle} />
      {right ? <div className="flex shrink-0 items-center">{right}</div> : null}
    </div>
  );
}

/** The left half of a card header (title + inline meta), for headers that lay out their own right side. */
export function CardHeadText({
  title,
  sub,
  subTitle,
  level = 2,
  className,
}: {
  title: ReactNode;
  sub?: ReactNode;
  subTitle?: string;
  level?: 2 | 3;
  className?: string;
}) {
  const Heading = level === 2 ? "h2" : "h3";
  return (
    <div className={cn("flex min-w-0 flex-1 items-baseline gap-2", className)}>
      <Heading className={cn("max-w-full shrink-0 truncate font-semibold tracking-tight", level === 2 ? "text-[15px]" : "text-[13px]")}>{title}</Heading>
      {sub ? (
        <p className="min-w-0 truncate text-xs text-faint" title={subTitle ?? (typeof sub === "string" ? sub : undefined)}>
          {sub}
        </p>
      ) : null}
    </div>
  );
}

/** A small muted info icon whose accessible name and tooltip carry a page's explainer text. */
export function InfoTip({ text, className }: { text: string; className?: string }) {
  return (
    <span data-page-info role="img" aria-label={text} title={text} className={cn("inline-flex shrink-0 cursor-help text-muted hover:text-fg", className)}>
      <Info className="h-3.5 w-3.5" aria-hidden />
    </span>
  );
}

/**
 * A page's header: one row with the title (and its explainer behind an info icon) on the left and the
 * page's own controls on the right. The sidebar already names the page, so nothing goes under it
 * (BAC-53, UI_ISSUES 4). The first section after it sits 12 px below (see `[data-page-head]` in tailwind.css).
 */
export function PageTitle({
  title,
  sub,
  right,
  growRight = false,
}: {
  title: string;
  /** The page's explainer: shown behind the info icon, never as a paragraph. */
  sub?: string;
  /** The page's own controls (range, filters, actions); keep them 32 px tall (h-8) so the row stays one line. */
  right?: ReactNode;
  /** Let the controls take the rest of the row (a search field), instead of sitting at the right edge. */
  growRight?: boolean;
}) {
  return (
    <div data-page-head className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
      <div className="flex min-w-0 items-center gap-1.5">
        <h1 className="truncate text-[17px] font-semibold leading-6 tracking-tight">{title}</h1>
        {sub ? <InfoTip text={sub} /> : null}
      </div>
      {right ? <div className={cn("flex min-w-0 flex-wrap items-center justify-end gap-2", growRight && "flex-1")}>{right}</div> : null}
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
