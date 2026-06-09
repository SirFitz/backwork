import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function fmtNum(n: number, digits = 1): string {
  if (!Number.isFinite(n)) return "—";
  if (Math.abs(n) >= 1000) return (n / 1000).toFixed(1) + "k";
  if (n === 0) return "0";
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

export function fmtBytesMB(mb: number): string {
  if (!Number.isFinite(mb) || mb <= 0) return "—";
  if (mb >= 1024) return (mb / 1024).toFixed(2) + " GB";
  return mb.toFixed(0) + " MB";
}

export function fmtRate(r: number): string {
  if (!Number.isFinite(r)) return "—";
  return fmtNum(r, 2) + "/s";
}

export function timeAgo(ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return s + "s ago";
  if (s < 3600) return Math.floor(s / 60) + "m ago";
  if (s < 86400) return Math.floor(s / 3600) + "h ago";
  return Math.floor(s / 86400) + "d ago";
}

export function fmtTime(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleTimeString("en-GB", { hour12: false }) + "." + String(d.getMilliseconds()).padStart(3, "0");
}

export const LEVEL_COLOR: Record<string, string> = {
  error: "text-err",
  fatal: "text-err",
  warn: "text-warn",
  warning: "text-warn",
  info: "text-info",
  debug: "text-muted",
};
