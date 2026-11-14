import { describe, expect, mock, test } from "bun:test";
import type { OrgContext } from "~/lib/auth/context.server";
import type { ProgressiveLookup, WindowResult } from "~/lib/hops/query.server";
import { buildRequestTree, requestSummary } from "~/lib/hops/tree";
import { SearchWindow, type HopId, type HopKind, type HopRecord, type TraceId, type TraceLogLine } from "~/lib/hops/types";
import { PIN_SNAPSHOT_MAX_BYTES, PinReason, type PinSnapshot, type PinnedRequest } from "./pins";
import { pinAction, withPinFallback, type PinActionDeps, type PinFallbackDeps } from "./pins.server";

const TRACE = "4bf92f3577b34da6a3ce929d0e0e4736" as TraceId;
const T0 = Date.UTC(2026, 10, 14, 12, 0, 0);
const DAY = 24 * 3600_000;
const hid = (n: number): HopId => n.toString(16).padStart(16, "0") as HopId;

function rec(kind: HopKind, id: number, parent: number | null, timeMs: number, extra: Partial<HopRecord> = {}): HopRecord {
  const end = kind === "in_end" || kind === "out_end";
  const out = kind === "out" || kind === "out_end";
  return {
    traceId: TRACE, hop: kind, hopId: hid(id), parentHop: parent ? hid(parent) : null, hopSent: out ? true : null, tracer: false, handoff: false,
    parentId: null, service: "shop-api", source: "shop-api", adapter: "test", via: "http", method: "GET", op: "/shop", peer: out ? "db.internal" : null,
    table: null, stmt: null, path: "/shop", attempt: null, outcome: end ? "ok" : null, status: end ? 200 : null, error: null,
    durationUs: end ? 42_000 : null, totals: null, fields: [], timeMs, ...extra,
  };
}

/** GET /shop with three database calls, the lines it logged, and one linked id. */
function shopSnapshot(at = T0): PinSnapshot {
  const records: HopRecord[] = [rec("in", 1, null, at)];
  for (let i = 0; i < 3; i++) {
    records.push(rec("out_end", 10 + i, 1, at + 5 + i * 2, { via: "db", method: null, op: "select", peer: "db.internal", table: "plans", stmt: "select plans.id from plans where plans.number = ?", durationUs: 1100, status: null, path: null }));
  }
  records.push(rec("in_end", 1, null, at + 42));
  const lines: TraceLogLine[] = [{ service: "shop-api", level: "info", timeMs: at + 1, line: `GET /shop trace_id=${TRACE}` }];
  return { records, lines, links: [{ traceId: TRACE, name: "order_id", value: "77", hopId: hid(1), service: "shop-api", timeMs: at + 2 }] };
}

function ctxOf(role: OrgContext["role"], orgId = "org-a"): OrgContext {
  return { user: { id: "user-1" } as OrgContext["user"], memberships: [], org: { id: orgId, name: "A", slug: "a" }, role };
}

function form(fields: Record<string, string>, origin: string | null = null): Request {
  const body = new URLSearchParams(fields);
  const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded", host: "localhost:3504" };
  if (origin) headers.origin = origin;
  return new Request(`http://localhost:3504/requests/${TRACE}`, { method: "POST", headers, body });
}

function deps(role: OrgContext["role"], over: Partial<PinActionDeps> = {}): PinActionDeps {
  return {
    context: async () => ctxOf(role),
    snapshot: async () => ({ ...shopSnapshot(), truncated: false }),
    pin: mock(async () => ({ ok: true as const, created: true, trimmed: false, bytes: 10, evicted: null })),
    unpin: mock(async () => true),
    isPinned: async () => false,
    audit: mock(async () => {}),
    now: () => T0,
    ...over,
  };
}

async function body(r: Response): Promise<{ ok: boolean; error?: string }> {
  return (await r.json()) as { ok: boolean; error?: string };
}

describe("pin action", () => {
  test("a viewer is refused and nothing is stored", async () => {
    const d = deps("viewer");
    const r = await pinAction(form({ intent: "pin" }), TRACE, d);
    expect(r.status).toBe(403);
    expect((await body(r)).error).toBe("Viewers cannot pin requests.");
    expect(d.pin).not.toHaveBeenCalled();
  });

  test("a member pins, with the server's own records rather than anything in the form", async () => {
    const d = deps("member");
    const forged = JSON.stringify({ records: [{ traceId: TRACE, hopId: "f", hop: "in", timeMs: 1 }] });
    const r = await pinAction(form({ intent: "pin", note: " slow checkout ", records: forged, lines: "[]" }), TRACE, d);
    expect(r.status).toBe(200);
    expect(await body(r)).toEqual({ ok: true, intent: "pin", trimmed: false } as never);
    const call = (d.pin as ReturnType<typeof mock>).mock.calls[0];
    expect(call[0]).toEqual({ orgId: "org-a", userId: "user-1" });
    expect(call[1]).toBe(TRACE);
    expect(call[2]).toEqual({ ...shopSnapshot(), truncated: false });
    expect(call[3]).toEqual({ reason: PinReason.Manual, note: "slow checkout" });
    expect(d.audit).toHaveBeenCalledTimes(1);
  });

  test("a request from another site is refused before anything runs", async () => {
    const d = deps("owner");
    let thrown: unknown = null;
    try {
      await pinAction(form({ intent: "pin" }, "https://evil.example"), TRACE, d);
    } catch (e: unknown) {
      thrown = e;
    }
    expect(thrown instanceof Response && thrown.status === 403).toBe(true);
    expect(d.pin).not.toHaveBeenCalled();
  });

  test("the trace id is validated", async () => {
    const d = deps("member");
    expect((await pinAction(form({ intent: "pin" }), null, d)).status).toBe(400);
    expect((await pinAction(form({ intent: "pin" }), "NOT-HEX" as TraceId, d)).status).toBe(400);
    expect(d.pin).not.toHaveBeenCalled();
  });

  test("unknown intent, expired request and the plan cap are refused with a reason", async () => {
    expect((await pinAction(form({ intent: "drop" }), TRACE, deps("member"))).status).toBe(400);
    const gone = await pinAction(form({ intent: "pin" }), TRACE, deps("member", { snapshot: async () => null }));
    expect(gone.status).toBe(404);
    const full = deps("member", { pin: async () => ({ ok: false as const, error: "You have 5 of 5 pinned requests on the Free plan. Unpin one first." }) });
    const r = await pinAction(form({ intent: "pin" }), TRACE, full);
    expect(r.status).toBe(409);
    expect((await body(r)).error).toBe("You have 5 of 5 pinned requests on the Free plan. Unpin one first.");
  });

  test("unpin removes and audits", async () => {
    const d = deps("member");
    const r = await pinAction(form({ intent: "unpin" }), TRACE, d);
    expect(r.status).toBe(200);
    expect(d.unpin).toHaveBeenCalledWith("org-a", TRACE);
    expect(d.audit).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------- loader fallback

function windowOf(window: SearchWindow, records: HopRecord[]): WindowResult {
  return { window, found: records.length > 0, records, links: [], searchedFromMs: T0 - 30 * DAY, truncated: false };
}

function lookupOf(hour: HopRecord[], day: HopRecord[] = [], retention: HopRecord[] = []): ProgressiveLookup {
  const h = Promise.resolve(windowOf(SearchWindow.Hour, hour));
  const d = h.then((r) => (r.found ? r : windowOf(SearchWindow.Day, day)));
  const all = d.then((r) => (r.found ? r : windowOf(SearchWindow.Retention, retention)));
  return { hour: h, day: d, retention: all };
}

const PIN: PinnedRequest = {
  traceId: TRACE, title: "GET /shop", note: "slow checkout", reason: PinReason.Manual, bytes: 100, pinnedAt: T0 - 10 * DAY,
  pinnedBy: "user-1", pinnedByName: "Agent", summary: null, trimmed: false, truncated: false,
};

function fallbackDeps(pinned: boolean, hopDays: number | null = null): PinFallbackDeps & { loads: number } {
  const out = {
    loads: 0,
    meta: async () => (pinned ? PIN : null),
    load: async () => {
      out.loads++;
      return pinned ? { ...PIN, ...shopSnapshot(T0 - 10 * DAY) } : null;
    },
    hopDays: async () => hopDays,
  };
  return out;
}

describe("withPinFallback", () => {
  test("Loki empty plus a pin renders the snapshot, with its lines", async () => {
    const d = fallbackDeps(true);
    const l = withPinFallback(lookupOf([]), "org-a", TRACE, T0, d);
    expect((await l.hour).copy).toBeNull();
    expect((await l.day).copy).toBeNull();
    const r = await l.retention;
    expect(r.result.found).toBe(true);
    expect(r.result.records).toEqual(shopSnapshot(T0 - 10 * DAY).records);
    expect(r.lines).toEqual(shopSnapshot(T0 - 10 * DAY).lines);
    expect(r.copy).toEqual({ pinnedAt: PIN.pinnedAt, reason: PinReason.Manual, note: "slow checkout", trimmed: false });
    expect(d.loads).toBe(1);
  });

  test("Loki present ignores the pin (but reports it, for the button)", async () => {
    const d = fallbackDeps(true, 30);
    const live = shopSnapshot(T0 - 60_000).records;
    const l = withPinFallback(lookupOf(live), "org-a", TRACE, T0, d);
    const r = await l.retention;
    expect(r.copy).toBeNull();
    expect(r.lines).toBeNull();
    expect(r.result.records).toBe(live);
    expect(r.pin?.traceId).toBe(TRACE);
    expect(d.loads).toBe(0);
  });

  test("live records older than the plan window give way to the pin", async () => {
    const old = shopSnapshot(T0 - 5 * DAY).records;
    const r = await withPinFallback(lookupOf([], [], old), "org-a", TRACE, T0, fallbackDeps(true, 3)).retention;
    expect(r.copy).not.toBeNull();
  });

  test("no pin, or a pin lookup that fails, leaves the live answer alone", async () => {
    const none = await withPinFallback(lookupOf([]), "org-a", TRACE, T0, fallbackDeps(false)).retention;
    expect(none.result.found).toBe(false);
    expect(none.copy).toBeNull();
    const broken: PinFallbackDeps = { meta: async () => { throw new Error("db down"); }, load: async () => null, hopDays: async () => null };
    const r = await withPinFallback(lookupOf(shopSnapshot().records), "org-a", TRACE, T0, broken).hour;
    expect(r.result.found).toBe(true);
    expect(r.pin).toBeNull();
  });
});

// ---------------------------------------------------------------- database (opt-in)

// DATABASE_URL=<url> USAGE_TEST_DATABASE_URL=<url> bun test app/lib/pins.server.test.ts
const url = process.env.USAGE_TEST_DATABASE_URL;
const ready = !!url && process.env.DATABASE_URL === url;

function traceN(n: number): TraceId {
  return n.toString(16).padStart(32, "a") as TraceId;
}

function snapFor(trace: TraceId, at: number): PinSnapshot {
  const s = shopSnapshot(at);
  return { records: s.records.map((r) => ({ ...r, traceId: trace })), lines: s.lines, links: s.links.map((l) => ({ ...l, traceId: trace })) };
}

describe("pinned requests in Postgres", () => {
  test.skipIf(!ready)("pin, load, list, update the note, unpin, cap, trimming and cascade", async () => {
    const { db, ensureSchema } = await import("~/db/index.server");
    const { sql } = await import("drizzle-orm");
    const pins = await import("./pins.server");
    await ensureSchema();
    const org = `pin-test-${Date.now()}`;
    await db.execute(sql`INSERT INTO orgs (id, name, slug, plan) VALUES (${org}, 'Pin test', ${org}, 'free')`);
    const actor = { orgId: org, userId: null };
    try {
      // Pin and load: the snapshot round-trips to the same tree.
      const original = shopSnapshot();
      const first = await pins.pinRequest(actor, TRACE, original, { reason: PinReason.Manual, note: "first" }, T0);
      expect(first).toEqual({ ok: true, created: true, trimmed: false, bytes: expect.any(Number), evicted: null } as never);
      const loaded = await pins.loadPin(org, TRACE);
      expect(loaded?.records).toEqual(original.records);
      expect(loaded?.lines).toEqual(original.lines);
      expect(loaded?.links).toEqual(original.links);
      expect(loaded?.title).toBe("GET /shop");
      const a = buildRequestTree(original.records, original.lines, T0 + 1000, original.links, null);
      const b = buildRequestTree(loaded!.records, loaded!.lines, T0 + 1000, loaded!.links, null);
      expect(requestSummary(b)).toEqual(requestSummary(a));
      expect(b.split).toEqual(a.split);
      expect(loaded?.summary).toEqual(requestSummary(a));

      // Pinning again updates the note only.
      const again = await pins.pinRequest(actor, TRACE, original, { reason: PinReason.Manual, note: "second" }, T0 + 5);
      expect(again.ok && again.created).toBe(false);
      expect((await pins.pinMeta(org, TRACE))?.note).toBe("second");

      // Four more fill the Free plan's five; the list is newest first and pages.
      for (let i = 1; i <= 4; i++) {
        const r = await pins.pinRequest(actor, traceN(i), snapFor(traceN(i), T0 + i), { reason: i % 2 ? PinReason.Slow : PinReason.Manual }, T0 + i * 1000);
        expect(r.ok).toBe(true);
      }
      const list = await pins.listPins(org, 10);
      expect(list.map((p) => p.traceId)).toEqual([traceN(4), traceN(3), traceN(2), traceN(1), TRACE]);
      const page = await pins.listPinsPage(org, undefined, 2);
      expect(page.rows.map((p) => p.traceId)).toEqual([traceN(4), traceN(3)]);
      const page2 = await pins.listPinsPage(org, page.next ?? undefined, 2);
      expect(page2.rows.map((p) => p.traceId)).toEqual([traceN(2), traceN(1)]);
      expect((await pins.pinUsage(org))).toEqual({ count: 5, limit: 5, plan: "Free" });

      // The sixth manual pin is refused; an automatic one evicts the oldest automatic pin.
      const sixth = await pins.pinRequest(actor, traceN(5), snapFor(traceN(5), T0), { reason: PinReason.Manual }, T0 + 9000);
      expect(sixth).toEqual({ ok: false, error: "You have 5 of 5 pinned requests on the Free plan. Unpin one first." });
      const auto = await pins.pinRequest(actor, traceN(6), snapFor(traceN(6), T0), { reason: PinReason.Failed }, T0 + 9500);
      expect(auto.ok && auto.evicted).toBe(traceN(1));
      expect(await pins.pinMeta(org, traceN(1))).toBeNull();

      // Unpin.
      expect(await pins.unpinRequest(org, traceN(6))).toBe(true);
      expect(await pins.unpinRequest(org, traceN(6))).toBe(false);

      // Over 2 MB: lines are cut and the pin says so.
      const big = shopSnapshot();
      big.lines = Array.from({ length: 3000 }, (_, i) => ({ service: "shop-api", level: "info", timeMs: T0 + i, line: "z".repeat(1000) }));
      const trimmed = await pins.pinRequest(actor, traceN(7), { ...big, records: big.records.map((r) => ({ ...r, traceId: traceN(7) })) }, { reason: PinReason.Manual }, T0);
      expect(trimmed.ok && trimmed.trimmed).toBe(true);
      expect(trimmed.ok && trimmed.bytes).toBeLessThanOrEqual(PIN_SNAPSHOT_MAX_BYTES);
      const t = await pins.pinMeta(org, traceN(7));
      expect(t?.trimmed).toBe(true);
      expect(t?.bytes).toBeLessThanOrEqual(PIN_SNAPSHOT_MAX_BYTES);
      expect((await pins.loadPin(org, traceN(7)))?.records.length).toBe(big.records.length);

      // Settings.
      expect(await pins.loadPinSettings(org)).toEqual({ slow: false, failed: false });
      await pins.savePinSettings(org, null, { slow: true, failed: false });
      expect(await pins.loadPinSettings(org)).toEqual({ slow: true, failed: false });
      expect((await pins.orgsWithAutoPins()).some((o) => o.orgId === org)).toBe(true);
    } finally {
      await db.execute(sql`DELETE FROM orgs WHERE id = ${org}`);
    }
    // Deleting the organisation removed its pins and settings.
    const left = await db.execute(sql`SELECT (SELECT count(*) FROM pinned_requests WHERE org_id = ${org})::int AS pins, (SELECT count(*) FROM pin_settings WHERE org_id = ${org})::int AS settings`);
    expect(left.rows[0]).toEqual({ pins: 0, settings: 0 });
  });

  test.skipIf(!ready)("the auto-pin job pins the slow and failed requests once, then respects the day", async () => {
    const { db, ensureSchema } = await import("~/db/index.server");
    const { sql } = await import("drizzle-orm");
    const pins = await import("./pins.server");
    const { runAutoPins } = await import("./pins-auto.server");
    await ensureSchema();
    const org = `pin-auto-${Date.now()}`;
    await db.execute(sql`INSERT INTO orgs (id, name, slug, plan) VALUES (${org}, 'Pin auto', ${org}, 'free')`);
    try {
      await pins.savePinSettings(org, null, { slow: true, failed: true });
      const row = (id: TraceId, ms: number, failed = false) => ({
        traceID: id, service: "shop-api", method: "GET", route: "/shop", path: "/shop", status: failed ? 500 : 200, durationMs: ms, startMs: T0 - 600_000 + ms, error: false, totals: null,
      });
      const rows = [row(traceN(11), 40), row(traceN(12), 41), row(traceN(13), 39), row(traceN(14), 42), row(traceN(15), 38), row(traceN(16), 950), row(traceN(17), 20, true)];
      const audit = mock(async () => {});
      const run = () => runAutoPins(T0, {
        orgs: async () => [{ orgId: org, slow: true, failed: true }],
        rows: async () => rows,
        existing: (o) => pins.listPins(o, 500),
        snapshot: async (traceId) => ({ ...snapFor(traceId, T0 - 600_000), truncated: false }),
        pin: pins.pinRequest,
        unpin: pins.unpinRequest,
        audit,
      });
      const first = await run();
      expect(first[0].pinned).toEqual([traceN(16), traceN(17)]);
      expect((await pins.pinMeta(org, traceN(16)))?.reason).toBe(PinReason.Slow);
      expect((await pins.pinMeta(org, traceN(17)))?.reason).toBe(PinReason.Failed);
      expect(audit).toHaveBeenCalledTimes(2);
      // The same hour again: everything is already pinned.
      expect((await run())[0].pinned).toEqual([]);
    } finally {
      await db.execute(sql`DELETE FROM orgs WHERE id = ${org}`);
    }
  });
});
