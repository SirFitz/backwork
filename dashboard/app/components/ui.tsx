import type { ReactNode } from "react";
import { cn } from "~/lib/utils";

export function Card({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <div className={cn("rounded-lg border border-border bg-panel", className)}>{children}</div>
  );
}

export function CardHeader({ title, subtitle, right }: { title: ReactNode; subtitle?: ReactNode; right?: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3 border-b border-border px-4 py-3">
      <div>
        <div className="text-sm font-semibold text-fg">{title}</div>
        {subtitle ? <div className="mt-0.5 text-xs text-muted">{subtitle}</div> : null}
      </div>
      {right}
    </div>
  );
}

const STATUS_STYLES: Record<string, { dot: string; text: string; label: string }> = {
  up: { dot: "bg-ok", text: "text-ok", label: "Operational" },
  degraded: { dot: "bg-warn", text: "text-warn", label: "Degraded" },
  down: { dot: "bg-err", text: "text-err", label: "Down" },
};

export function StatusDot({ status, pulse }: { status: "up" | "degraded" | "down"; pulse?: boolean }) {
  const s = STATUS_STYLES[status] ?? STATUS_STYLES.up;
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={cn("h-2 w-2 rounded-full", s.dot, pulse && status !== "up" && "animate-[pulse_1.5s_ease-in-out_infinite]")} />
      <span className={cn("text-xs font-medium", s.text)}>{s.label}</span>
    </span>
  );
}

export function Badge({ children, tone = "default", className }: { children: ReactNode; tone?: "default" | "ok" | "warn" | "err" | "info" | "brand"; className?: string }) {
  const tones: Record<string, string> = {
    default: "bg-panel-2 text-muted border-border",
    ok: "bg-ok/10 text-ok border-ok/30",
    warn: "bg-warn/10 text-warn border-warn/30",
    err: "bg-err/10 text-err border-err/30",
    info: "bg-info/10 text-info border-info/30",
    brand: "bg-brand/10 text-brand border-brand/30",
  };
  return (
    <span className={cn("inline-flex items-center rounded border px-1.5 py-0.5 text-[11px] font-medium leading-none", tones[tone], className)}>
      {children}
    </span>
  );
}

export function Stat({ label, value, sub, tone }: { label: string; value: ReactNode; sub?: ReactNode; tone?: string }) {
  return (
    <div className="px-4 py-3">
      <div className="text-[11px] uppercase tracking-wide text-muted">{label}</div>
      <div className={cn("mt-1 font-mono text-2xl font-semibold tabular-nums", tone)}>{value}</div>
      {sub ? <div className="mt-0.5 text-xs text-muted">{sub}</div> : null}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="px-4 py-10 text-center text-sm text-muted">{children}</div>;
}

export function ErrorNote({ error }: { error: string | null }) {
  if (!error) return null;
  return (
    <div className="mx-4 my-2 rounded border border-warn/30 bg-warn/5 px-3 py-2 text-xs text-warn">
      data source unavailable — {error.slice(0, 160)}
    </div>
  );
}
