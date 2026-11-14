// Pinned requests (BAC-78): caps, snapshot trimming, the loader's fallback rule and the auto-pin
// picker. Pure: no Loki, Remix or database imports, so the request view and the requests list can
// use the types and labels in the browser, and every rule is tested with plain objects.
import { PLANS } from "~/components/site/plans";
import { splitRequests } from "~/lib/hops/split";
import { buildRequestTree, headHop, requestSummary, type RequestSummary } from "~/lib/hops/tree";
import { requestPath } from "~/lib/hops/paths";
import type { HopRecord, LinkedId, TraceLogLine } from "~/lib/hops/types";

/** Why a request was pinned. */
export const PinReason = { Manual: "manual", Slow: "slow", Failed: "failed" } as const;
export type PinReason = (typeof PinReason)[keyof typeof PinReason];

export function isPinReason(v: unknown): v is PinReason {
  return typeof v === "string" && (Object.values(PinReason) as string[]).includes(v);
}

/** The request view's action intents. */
export const PinIntent = { Pin: "pin", Unpin: "unpin" } as const;
export type PinIntent = (typeof PinIntent)[keyof typeof PinIntent];

/** Pins an organisation may hold, by plan value (`orgs.plan`). Unknown values get the Free cap. */
export const PIN_LIMITS = { free: 5, team: 100, business: 500, enterprise: 500, unmetered: 200 } as const;
/** Largest stored snapshot (records, lines and links as JSON), bytes. */
export const PIN_SNAPSHOT_MAX_BYTES = 2 * 1024 * 1024;
/** Longest note kept on a pin, characters. */
export const PIN_NOTE_MAX_CHARS = 200;
/** Version of the stored snapshot envelope, for a later migration of the record format. */
export const PIN_FORMAT_VERSION = 1;

/** Automatic pins per organisation per UTC day, all reasons together. */
export const AUTO_PINS_PER_DAY = 3;
/** A slow pick must be at least this many times its route's median among the scanned rows. */
export const AUTO_SLOW_MEDIAN_FACTOR = 2;
/** A slow pick must take at least this long, ms. */
export const AUTO_SLOW_MIN_MS = 500;
/** A route needs at least this many scanned rows before its median means anything. */
export const AUTO_SLOW_MIN_ROWS = 5;

const DAY_MS = 24 * 60 * 60 * 1000;

/** What a pin stores: the same raw data the request view builds its tree from. */
export interface PinSnapshot {
  records: HopRecord[];
  lines: TraceLogLine[];
  links: LinkedId[];
}

/** One pinned request, without its snapshot. */
export interface PinnedRequest {
  traceId: string;
  title: string;
  note: string | null;
  reason: PinReason;
  bytes: number;
  /** Epoch ms. */
  pinnedAt: number;
  /** User id; null for an automatic pin or a removed user. */
  pinnedBy: string | null;
  pinnedByName: string | null;
  summary: RequestSummary | null;
  /** Over the 2 MB cap, so log lines (then the oldest records) were left out. */
  trimmed: boolean;
  /** The fetch hit Loki's line limit when pinned, so older records may be missing. */
  truncated: boolean;
}

/** What the request view shows about a copy it rendered from a pin. */
export interface PinnedCopyInfo {
  pinnedAt: number;
  reason: PinReason;
  note: string | null;
  trimmed: boolean;
}

/** The pin action's answer, as the browser receives it. */
export type PinActionData = { ok: true; intent: PinIntent; trimmed: boolean } | { ok: false; error: string };

/** One page of the pinned list. */
export interface PinPage {
  rows: PinnedRequest[];
  /** Pass as `before` for the next page (`pinCursor`); null when there is none. */
  next: string | null;
}

/** Where a page of pins ends: pinned time and trace id, so pins saved in the same millisecond are not skipped. */
export interface PinCursor {
  pinnedAt: number;
  traceId: string;
}

export function pinCursor(p: PinCursor): string {
  return `${p.pinnedAt}.${p.traceId}`;
}

export function parsePinCursor(raw: string | null | undefined): PinCursor | null {
  const m = /^(\d{1,15})\.([0-9a-f]{32})$/.exec(raw ?? "");
  return m ? { pinnedAt: Number(m[1]), traceId: m[2] } : null;
}

// ---------------------------------------------------------------- caps

export function pinLimitFor(plan: string): number {
  return plan in PIN_LIMITS ? PIN_LIMITS[plan as keyof typeof PIN_LIMITS] : PIN_LIMITS.free;
}

/** "Free", "Team"; null for an unmetered organisation (no plan to name). */
export function planLabel(plan: string): string | null {
  if (plan === "unmetered") return null;
  return PLANS.find((p) => p.id === plan)?.name ?? "Free";
}

export function overCapMessage(count: number, limit: number, plan: string): string {
  const label = planLabel(plan);
  return `You have ${count} of ${limit} pinned requests${label ? ` on the ${label} plan` : ""}. Unpin one first.`;
}

/** The fields the cap decision needs from each existing pin. */
export interface PinSlotRow {
  traceId: string;
  reason: PinReason;
  pinnedAt: number;
}

export const SlotKind = { Fits: "fits", Update: "update", Evict: "evict", Refuse: "refuse" } as const;
export type SlotKind = (typeof SlotKind)[keyof typeof SlotKind];

export type SlotDecision =
  | { kind: typeof SlotKind.Fits }
  | { kind: typeof SlotKind.Update }
  | { kind: typeof SlotKind.Evict; traceId: string }
  | { kind: typeof SlotKind.Refuse; message: string };

/**
 * Room for one more pin. Pinning a request that is already pinned only updates it. Over the cap a
 * manual pin is refused; an automatic one replaces the oldest automatic pin, never a manual one.
 */
export function pinSlot(traceId: string, reason: PinReason, plan: string, pins: readonly PinSlotRow[]): SlotDecision {
  if (pins.some((p) => p.traceId === traceId)) return { kind: SlotKind.Update };
  const limit = pinLimitFor(plan);
  if (pins.length < limit) return { kind: SlotKind.Fits };
  const refuse = { kind: SlotKind.Refuse, message: overCapMessage(pins.length, limit, plan) } as const;
  if (reason === PinReason.Manual) return refuse;
  const autos = pins.filter((p) => p.reason !== PinReason.Manual).sort((a, b) => a.pinnedAt - b.pinnedAt);
  return autos.length ? { kind: SlotKind.Evict, traceId: autos[0].traceId } : refuse;
}

// ---------------------------------------------------------------- snapshot size

const encoder = new TextEncoder();

function jsonBytes(v: unknown): number {
  return encoder.encode(JSON.stringify(v)).length;
}

/** Bytes of the three arrays as stored (JSON). */
export function snapshotBytes(s: PinSnapshot): number {
  return jsonBytes(s.records) + jsonBytes(s.lines) + jsonBytes(s.links);
}

export interface TrimmedSnapshot {
  snapshot: PinSnapshot;
  bytes: number;
  trimmed: boolean;
}

/** Cut from the front of `items` (sorted oldest first) until `over` bytes are gone. */
function cutOldest<T>(items: readonly T[], over: number): { kept: T[]; freed: number } {
  let freed = 0;
  let i = 0;
  // Each element also costs its separating comma.
  while (i < items.length && freed < over) freed += jsonBytes(items[i++]) + 1;
  return { kept: items.slice(i), freed };
}

/** Fit a snapshot under `maxBytes`: the oldest log lines go first, then the oldest records. */
export function trimSnapshot(s: PinSnapshot, maxBytes: number = PIN_SNAPSHOT_MAX_BYTES): TrimmedSnapshot {
  const total = snapshotBytes(s);
  if (total <= maxBytes) return { snapshot: s, bytes: total, trimmed: false };
  const lines = [...s.lines].sort((a, b) => a.timeMs - b.timeMs);
  const l = cutOldest(lines, total - maxBytes);
  let over = total - l.freed - maxBytes;
  let records = s.records;
  if (over > 0) {
    const r = cutOldest([...s.records].sort((a, b) => a.timeMs - b.timeMs), over);
    records = r.kept;
    over -= r.freed;
  }
  const snapshot: PinSnapshot = { records, lines: l.kept, links: s.links };
  return { snapshot, bytes: snapshotBytes(snapshot), trimmed: true };
}

// ---------------------------------------------------------------- what the pin is called

/** The summary and title of the first request in the snapshot ("GET /shop"). */
export function describeSnapshot(s: PinSnapshot, now: number): { title: string; summary: RequestSummary | null } {
  const part = splitRequests(s.records, s.lines, s.links)[0];
  if (!part) return { title: "request", summary: null };
  const tree = buildRequestTree(part.records, part.logs, now, part.links, null);
  const head = headHop(tree);
  if (!head) return { title: "request", summary: null };
  const label = requestPath(head) ?? head.op ?? head.service;
  return { title: `${head.method ? `${head.method} ` : ""}${label}`.slice(0, 200), summary: requestSummary(tree) };
}

/** A note as stored: printable, trimmed, at most `PIN_NOTE_MAX_CHARS`; null when empty. */
export function cleanNote(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  // eslint-disable-next-line no-control-regex
  const text = raw.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, PIN_NOTE_MAX_CHARS);
  return text || null;
}

// ---------------------------------------------------------------- loader fallback

/**
 * Render the pinned copy instead of the live records? Yes when a pin exists and Loki found nothing,
 * or the live records are older than the plan keeps request records (the trim is about to remove them).
 */
export function pinnedCopyWanted(live: { found: boolean; earliestMs: number | null }, pinned: boolean, hopDays: number | null, now: number): boolean {
  if (!pinned) return false;
  if (!live.found) return true;
  return hopDays !== null && live.earliestMs !== null && live.earliestMs < now - hopDays * DAY_MS;
}

// ---------------------------------------------------------------- words

/** "10 Nov 14:02", in UTC or the viewer's zone. */
export function fmtPinnedAt(ms: number, local: boolean): string {
  const zone = local ? {} : { timeZone: "UTC" };
  const day = new Date(ms).toLocaleDateString("en-GB", { day: "numeric", month: "short", ...zone });
  const time = new Date(ms).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, ...zone });
  return `${day} ${time}`;
}

export const PIN_REASON_LABEL: Record<PinReason, string> = {
  [PinReason.Manual]: "pinned by hand",
  [PinReason.Slow]: "kept as the slowest of its day",
  [PinReason.Failed]: "kept as a failed request",
};

/** Short form for the list's Reason column. */
export const PIN_REASON_SHORT: Record<PinReason, string> = {
  [PinReason.Manual]: "by hand",
  [PinReason.Slow]: "slowest",
  [PinReason.Failed]: "failed",
};

// ---------------------------------------------------------------- automatic pins

/** The fields of a requests-list row the picker reads (`RequestListRow` fits). */
export interface AutoPinRow {
  traceID: string;
  service: string;
  method: string;
  route: string;
  status: number | null;
  durationMs: number;
  startMs: number;
  error: boolean;
}

export interface AutoPinSettings {
  slow: boolean;
  failed: boolean;
}

export interface AutoPick {
  traceId: string;
  reason: PinReason;
  /** Today's slow pin this one replaces (a slower request came in); null when it adds a pin. */
  replaces: string | null;
}

function median(values: readonly number[]): number {
  const a = [...values].sort((x, y) => x - y);
  const mid = Math.floor(a.length / 2);
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

function isFailedRow(r: AutoPinRow): boolean {
  return r.error || (r.status !== null && r.status >= 500);
}

/** Start of `now`'s UTC day, epoch ms. */
export function utcDayStart(now: number): number {
  return Math.floor(now / DAY_MS) * DAY_MS;
}

/**
 * From the last hour's inbound rows: the slowest finished request (at least twice its route's median
 * and at least 500 ms, on a route with 5 or more rows), which replaces today's slow pin only when it
 * is slower, and the first failed request. Nothing already pinned; at most 3 automatic pins a day.
 */
export function pickAutoPins(rows: readonly AutoPinRow[], existing: readonly PinnedRequest[], settings: AutoPinSettings, now: number): AutoPick[] {
  const picks: AutoPick[] = [];
  const pinned = new Set(existing.map((p) => p.traceId));
  const dayStart = utcDayStart(now);
  const autoToday = existing.filter((p) => p.reason !== PinReason.Manual && p.pinnedAt >= dayStart);
  let budget = AUTO_PINS_PER_DAY - autoToday.length;

  if (settings.slow) {
    const byRoute = new Map<string, AutoPinRow[]>();
    for (const r of rows) {
      if (isFailedRow(r)) continue;
      const key = `${r.service} ${r.method} ${r.route}`;
      byRoute.set(key, [...(byRoute.get(key) ?? []), r]);
    }
    let best: AutoPinRow | null = null;
    for (const group of byRoute.values()) {
      if (group.length < AUTO_SLOW_MIN_ROWS) continue;
      const floor = Math.max(AUTO_SLOW_MEDIAN_FACTOR * median(group.map((r) => r.durationMs)), AUTO_SLOW_MIN_MS);
      for (const r of group) {
        if (r.durationMs >= floor && !pinned.has(r.traceID) && (!best || r.durationMs > best.durationMs)) best = r;
      }
    }
    if (best) {
      const todaySlow = autoToday.find((p) => p.reason === PinReason.Slow) ?? null;
      if (todaySlow) {
        const was = todaySlow.summary?.durationUs ?? null;
        if (was !== null && best.durationMs * 1000 > was) picks.push({ traceId: best.traceID, reason: PinReason.Slow, replaces: todaySlow.traceId });
      } else if (budget > 0) {
        picks.push({ traceId: best.traceID, reason: PinReason.Slow, replaces: null });
        budget--;
      }
    }
  }

  if (settings.failed && budget > 0) {
    const taken = new Set(picks.map((p) => p.traceId));
    const first = rows
      .filter((r) => isFailedRow(r) && !pinned.has(r.traceID) && !taken.has(r.traceID))
      .sort((a, b) => a.startMs - b.startMs)[0];
    if (first) picks.push({ traceId: first.traceID, reason: PinReason.Failed, replaces: null });
  }
  return picks;
}
