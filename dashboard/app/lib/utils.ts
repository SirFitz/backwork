import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function fmtNum(n: number, digits = 1): string {
  if (!Number.isFinite(n)) return "—";
  if (n === 0) return "0";
  if (Math.abs(n) >= 1000) return (n / 1000).toFixed(1) + "k";
  if (Math.abs(n) < 1) return n.toFixed(2);
  return n.toFixed(digits);
}

export function fmtMs(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "—";
  if (ms < 1) return ms.toFixed(2) + "ms";
  if (ms < 1000) return Math.round(ms) + "ms";
  return (ms / 1000).toFixed(2) + "s";
}

export function fmtPct(p: number, digits = 1): string {
  if (!Number.isFinite(p)) return "—";
  return p.toFixed(digits) + "%";
}

export function fmtBytes(b: number): string {
  if (!Number.isFinite(b) || b <= 0) return "—";
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (b >= 1024 && i < u.length - 1) {
    b /= 1024;
    i++;
  }
  return (i === 0 ? b.toFixed(0) : b.toFixed(b < 10 ? 2 : 1)) + " " + u[i];
}

export function fmtBytesRate(bps: number): string {
  if (!Number.isFinite(bps) || bps <= 0) return "0 B/s";
  return fmtBytes(bps) + "/s";
}

export function fmtRate(r: number, unit = "/s"): string {
  if (!Number.isFinite(r)) return "—";
  return fmtNum(r, 2) + unit;
}

export function fmtCores(c: number): string {
  if (!Number.isFinite(c) || c <= 0) return "0";
  if (c < 0.01) return "<0.01";
  return c.toFixed(c < 1 ? 2 : 1);
}

export function timeAgo(ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 5) return "just now";
  if (s < 60) return s + "s ago";
  if (s < 3600) return Math.floor(s / 60) + "m ago";
  if (s < 86400) return Math.floor(s / 3600) + "h ago";
  return Math.floor(s / 86400) + "d ago";
}

export function fmtClock(ts: number): string {
  const d = new Date(ts);
  return (
    d.toLocaleTimeString("en-GB", { hour12: false }) +
    "." +
    String(d.getMilliseconds()).padStart(3, "0")
  );
}

export const LEVEL_TEXT: Record<string, string> = {
  error: "text-err",
  fatal: "text-err",
  warn: "text-warn",
  warning: "text-warn",
  info: "text-info",
  debug: "text-faint",
};
