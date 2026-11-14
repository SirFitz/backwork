import { describe, expect, test } from "bun:test";
import {
  AUTO_PINS_PER_DAY,
  PIN_LIMITS,
  PinReason,
  SlotKind,
  cleanNote,
  describeSnapshot,
  fmtPinnedAt,
  overCapMessage,
  parsePinCursor,
  pickAutoPins,
  pinCursor,
  pinLimitFor,
  pinSlot,
  pinnedCopyWanted,
  snapshotBytes,
  trimSnapshot,
  utcDayStart,
  type AutoPinRow,
  type PinSlotRow,
  type PinnedRequest,
} from "./pins";
import type { HopId, HopKind, HopRecord, TraceId, TraceLogLine } from "./hops/types";

const TRACE = "4bf92f3577b34da6a3ce929d0e0e4736" as TraceId;
const T0 = Date.UTC(2026, 10, 14, 12, 0, 0);
const DAY = 24 * 3600_000;
const hid = (n: number): HopId => n.toString(16).padStart(16, "0") as HopId;

function rec(kind: HopKind, id: number, timeMs: number, extra: Partial<HopRecord> = {}): HopRecord {
  const end = kind === "in_end" || kind === "out_end";
  return {
    traceId: TRACE, hop: kind, hopId: hid(id), parentHop: null, hopSent: null, tracer: false, handoff: false, parentId: null,
    service: "shop-api", source: "shop-api", adapter: "test", via: "http", method: "GET", op: "/shop", peer: null, table: null, stmt: null,
    path: "/shop", attempt: null, outcome: end ? "ok" : null, status: end ? 200 : null, error: null, durationUs: end ? 42_000 : null,
    totals: null, fields: [], timeMs, ...extra,
  };
}

const line = (at: number, text = "x"): TraceLogLine => ({ service: "shop-api", level: "info", timeMs: T0 + at, line: text });

describe("caps per plan", () => {
  test("each plan has its cap, an unknown plan the Free one", () => {
    expect(pinLimitFor("free")).toBe(5);
    expect(pinLimitFor("team")).toBe(100);
    expect(pinLimitFor("business")).toBe(500);
    expect(pinLimitFor("enterprise")).toBe(500);
    expect(pinLimitFor("unmetered")).toBe(200);
    expect(pinLimitFor("something-else")).toBe(PIN_LIMITS.free);
  });

  test("the refusal names the plan, or none when unmetered", () => {
    expect(overCapMessage(5, 5, "free")).toBe("You have 5 of 5 pinned requests on the Free plan. Unpin one first.");
    expect(overCapMessage(200, 200, "unmetered")).toBe("You have 200 of 200 pinned requests. Unpin one first.");
  });
});

describe("pinSlot", () => {
  const five: PinSlotRow[] = [1, 2, 3, 4, 5].map((n) => ({ traceId: `t${n}`, reason: n === 2 || n === 4 ? PinReason.Slow : PinReason.Manual, pinnedAt: T0 + n }));

  test("under the cap a pin fits; a pinned request only updates", () => {
    expect(pinSlot("new", PinReason.Manual, "free", five.slice(0, 4))).toEqual({ kind: SlotKind.Fits });
    expect(pinSlot("t3", PinReason.Manual, "free", five)).toEqual({ kind: SlotKind.Update });
  });

  test("over the cap a manual pin is refused", () => {
    expect(pinSlot("new", PinReason.Manual, "free", five)).toEqual({ kind: SlotKind.Refuse, message: overCapMessage(5, 5, "free") });
  });

  test("over the cap an automatic pin evicts the oldest automatic pin, never a manual one", () => {
    expect(pinSlot("new", PinReason.Failed, "free", five)).toEqual({ kind: SlotKind.Evict, traceId: "t2" });
    const manualOnly = five.map((p) => ({ ...p, reason: PinReason.Manual }));
    expect(pinSlot("new", PinReason.Slow, "free", manualOnly).kind).toBe(SlotKind.Refuse);
  });
});

describe("trimSnapshot", () => {
  test("under the cap nothing changes", () => {
    const s = { records: [rec("in", 1, T0), rec("in_end", 1, T0 + 42)], lines: [line(1)], links: [] };
    const t = trimSnapshot(s, 1_000_000);
    expect(t.trimmed).toBe(false);
    expect(t.snapshot).toBe(s);
    expect(t.bytes).toBe(snapshotBytes(s));
  });

  test("log lines go first, oldest first, and records stay whole", () => {
    const records = [rec("in", 1, T0), rec("in_end", 1, T0 + 42)];
    const lines = Array.from({ length: 20 }, (_, i) => line(i, "y".repeat(100)));
    const s = { records, lines, links: [] };
    const max = snapshotBytes(s) - 500;
    const t = trimSnapshot(s, max);
    expect(t.trimmed).toBe(true);
    expect(t.bytes).toBeLessThanOrEqual(max);
    expect(t.snapshot.records).toEqual(records);
    expect(t.snapshot.lines.length).toBeLessThan(20);
    expect(t.snapshot.lines[t.snapshot.lines.length - 1]).toEqual(lines[19]);
  });

  test("then the oldest records", () => {
    const records = Array.from({ length: 30 }, (_, i) => rec("out_end", i + 2, T0 + i, { via: "db", stmt: "select ".padEnd(200, "x") }));
    const s = { records, lines: [line(1)], links: [] };
    const max = snapshotBytes(s) - 2000;
    const t = trimSnapshot(s, max);
    expect(t.bytes).toBeLessThanOrEqual(max);
    expect(t.snapshot.lines).toEqual([]);
    expect(t.snapshot.records.length).toBeLessThan(30);
    expect(t.snapshot.records[t.snapshot.records.length - 1]).toEqual(records[29]);
  });
});

describe("describeSnapshot and notes", () => {
  test("titles the first request by method and path", () => {
    const d = describeSnapshot({ records: [rec("in", 1, T0), rec("in_end", 1, T0 + 42)], lines: [], links: [] }, T0 + 1000);
    expect(d.title).toBe("GET /shop");
    expect(d.summary?.durationUs).toBe(42_000);
    expect(d.summary?.status).toBe(200);
  });

  test("notes are cleaned and capped; empty is null", () => {
    expect(cleanNote("  slow \n checkout ")).toBe("slow checkout");
    expect(cleanNote("   ")).toBeNull();
    expect(cleanNote(null)).toBeNull();
    expect(cleanNote("a".repeat(500))?.length).toBe(200);
  });

  test("pinned time reads as 14 Nov 12:00 in UTC", () => {
    expect(fmtPinnedAt(T0, false)).toBe("14 Nov 12:00");
  });
});

describe("pin cursor", () => {
  test("round-trips pinned time and trace id; anything else is no cursor", () => {
    expect(parsePinCursor(pinCursor({ pinnedAt: T0, traceId: TRACE }))).toEqual({ pinnedAt: T0, traceId: TRACE });
    expect(parsePinCursor("1")).toBeNull();
    expect(parsePinCursor(`${T0}.NOTHEX`)).toBeNull();
    expect(parsePinCursor(null)).toBeNull();
  });
});

describe("pinnedCopyWanted", () => {
  test("Loki empty plus a pin renders the pin; Loki present ignores it", () => {
    expect(pinnedCopyWanted({ found: false, earliestMs: null }, true, null, T0)).toBe(true);
    expect(pinnedCopyWanted({ found: true, earliestMs: T0 - 3600_000 }, true, 30, T0)).toBe(false);
    expect(pinnedCopyWanted({ found: false, earliestMs: null }, false, null, T0)).toBe(false);
  });

  test("records older than the plan window give way to the pin", () => {
    expect(pinnedCopyWanted({ found: true, earliestMs: T0 - 4 * DAY }, true, 3, T0)).toBe(true);
    expect(pinnedCopyWanted({ found: true, earliestMs: T0 - 4 * DAY }, true, null, T0)).toBe(false);
  });
});

describe("pickAutoPins", () => {
  const row = (id: string, ms: number, extra: Partial<AutoPinRow> = {}): AutoPinRow => ({
    traceID: id, service: "shop-api", method: "GET", route: "/shop", status: 200, durationMs: ms, startMs: T0 - 1000 + ms, error: false, ...extra,
  });
  const usual = [row("a", 40), row("b", 42), row("c", 45), row("d", 38), row("e", 41), row("slow", 900)];
  const both = { slow: true, failed: true };
  const pin = (traceId: string, reason: PinReason, pinnedAt: number, durationUs: number | null = null): PinnedRequest => ({
    traceId, title: "", note: null, reason, bytes: 0, pinnedAt, pinnedBy: null, pinnedByName: null, trimmed: false, truncated: false,
    summary: durationUs === null ? null : { traceId: TRACE, service: "shop-api", method: "GET", op: "/shop", via: "http", status: 200, failed: false, state: "finished", services: 1, durationUs, startMs: 0 },
  });

  test("the slowest at 2x the route median and 500 ms, and the first failed", () => {
    const rows = [...usual, row("f2", 30, { status: 500, startMs: T0 - 100 }), row("f1", 30, { error: true, startMs: T0 - 900 })];
    expect(pickAutoPins(rows, [], both, T0)).toEqual([
      { traceId: "slow", reason: PinReason.Slow, replaces: null },
      { traceId: "f1", reason: PinReason.Failed, replaces: null },
    ]);
  });

  test("below 500 ms or below twice the median is not slow", () => {
    expect(pickAutoPins([...usual.slice(0, 5), row("x", 400)], [], both, T0)).toEqual([]);
    const busy = [row("a", 600), row("b", 650), row("c", 700), row("d", 620), row("e", 640), row("x", 1000)];
    expect(pickAutoPins(busy, [], both, T0)).toEqual([]);
  });

  test("fewer than 5 rows on the route gives no slow pick", () => {
    expect(pickAutoPins([row("a", 40), row("b", 41), row("c", 39), row("slow", 900)], [], both, T0)).toEqual([]);
  });

  test("already pinned requests are skipped", () => {
    const rows = [...usual, row("f1", 30, { error: true })];
    expect(pickAutoPins(rows, [pin("slow", PinReason.Manual, T0 - DAY), pin("f1", PinReason.Manual, T0 - DAY)], both, T0)).toEqual([]);
  });

  test("the daily limit counts today's automatic pins only", () => {
    const today = utcDayStart(T0);
    const full = Array.from({ length: AUTO_PINS_PER_DAY }, (_, i) => pin(`old${i}`, PinReason.Failed, today + i));
    const rows = [...usual, row("f1", 30, { error: true })];
    expect(pickAutoPins(rows, full, { slow: false, failed: true }, T0)).toEqual([]);
    const yesterday = full.map((p) => ({ ...p, pinnedAt: today - 1000 }));
    expect(pickAutoPins(rows, yesterday, { slow: false, failed: true }, T0)).toEqual([{ traceId: "f1", reason: PinReason.Failed, replaces: null }]);
  });

  test("a slower request replaces today's slow pin; a faster one does not", () => {
    const today = utcDayStart(T0);
    expect(pickAutoPins(usual, [pin("was", PinReason.Slow, today + 5, 700_000)], both, T0)).toEqual([{ traceId: "slow", reason: PinReason.Slow, replaces: "was" }]);
    expect(pickAutoPins(usual, [pin("was", PinReason.Slow, today + 5, 1_200_000)], both, T0)).toEqual([]);
  });

  test("switches that are off pick nothing", () => {
    expect(pickAutoPins([...usual, row("f1", 30, { error: true })], [], { slow: false, failed: false }, T0)).toEqual([]);
  });
});
