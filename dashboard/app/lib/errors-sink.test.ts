import { describe, expect, test } from "bun:test";
import { fromLogLine, type DerivedError } from "./errors-derive";
import { DerivedErrorSink, type DerivedErrorStore, type EventWrite, type GroupWrite, type UpsertedGroup } from "./errors-sink";

/** An in-memory store with the database's semantics: (org, project, fingerprint) unique, update-only never creates. */
class MemoryStore implements DerivedErrorStore {
  groups = new Map<string, { id: string; count: number; status: string }>();
  events: EventWrite[] = [];
  calls = { upsert: 0, update: 0, events: 0 };
  private seq = 0;
  async upsertGroups(orgId: string, project: string, gs: readonly GroupWrite[]): Promise<UpsertedGroup[]> {
    this.calls.upsert++;
    return gs.map((g) => {
      const key = `${orgId}|${project}|${g.fingerprint}`;
      const row = this.groups.get(key);
      if (row) {
        row.count += g.count;
        if (row.status !== "ignored") row.status = "open";
        return { id: row.id, fingerprint: g.fingerprint, inserted: false };
      }
      const id = `g${++this.seq}`;
      this.groups.set(key, { id, count: g.count, status: "open" });
      return { id, fingerprint: g.fingerprint, inserted: true };
    });
  }
  async updateGroups(orgId: string, project: string, gs: readonly GroupWrite[]): Promise<UpsertedGroup[]> {
    this.calls.update++;
    const out: UpsertedGroup[] = [];
    for (const g of gs) {
      const row = this.groups.get(`${orgId}|${project}|${g.fingerprint}`);
      if (!row) continue;
      row.count += g.count;
      out.push({ id: row.id, fingerprint: g.fingerprint, inserted: false });
    }
    return out;
  }
  async insertEvents(_orgId: string, es: readonly EventWrite[]): Promise<void> {
    this.calls.events++;
    this.events.push(...es);
  }
}

const err = (msg: string, at = 0): DerivedError => fromLogLine({ line: msg, service: "svc", level: "error", traceId: null, at })!;
const limits = { newGroupsPerMinute: 3, eventsPerGroupPerMinute: 2, maxInFlight: 2, knownPerOrg: 100 };

describe("DerivedErrorSink", () => {
  test("one push → one upsert and one event insert; repeats of one failure are one group", async () => {
    const store = new MemoryStore();
    const sink = new DerivedErrorSink(store, limits, () => 0);
    const r = await sink.flush("o", "p", [err("order 1 failed"), err("order 2 failed"), err("db down")]);
    expect(store.calls).toEqual({ upsert: 1, update: 0, events: 1 });
    expect(r.groups).toBe(2);
    expect(r.created).toBe(2);
    expect([...store.groups.values()].map((g) => g.count).sort()).toEqual([1, 2]);
  });

  test("events per group per minute are capped, the count stays accurate", async () => {
    const store = new MemoryStore();
    const sink = new DerivedErrorSink(store, limits, () => 0);
    await sink.flush("o", "p", [err("x 1"), err("x 2"), err("x 3"), err("x 4", 9)]);
    await sink.flush("o", "p", [err("x 5")]);
    const g = [...store.groups.values()][0];
    expect(g.count).toBe(5);
    expect(store.events.length).toBe(2);
    expect(store.events.at(-1)!.payload.message).toBe("x 4"); // newest kept
    expect(sink.stats.sampled).toBe(3);
  });

  test("the per-group window resets each minute", async () => {
    let t = 0;
    const store = new MemoryStore();
    const sink = new DerivedErrorSink(store, limits, () => t);
    await sink.flush("o", "p", [err("x 1"), err("x 2"), err("x 3")]);
    t = 61_000;
    await sink.flush("o", "p", [err("x 4")]);
    expect(store.events.length).toBe(3);
  });

  test("new groups per org per minute are capped; existing groups still count past the cap", async () => {
    const store = new MemoryStore();
    const sink = new DerivedErrorSink(store, limits, () => 0);
    await sink.flush("o", "p", [err("a"), err("b"), err("c"), err("d"), err("e")]);
    expect(store.groups.size).toBe(3);
    expect(sink.stats.droppedNewGroup).toBe(2);
    // a known group keeps counting after the cap is reached
    await sink.flush("o", "p", [err("a"), err("f")]);
    expect(store.groups.size).toBe(3);
    expect(store.groups.get(`o|p|${err("a").fingerprint}`)!.count).toBe(2);
    // another org has its own budget
    await sink.flush("o2", "p", [err("a")]);
    expect(store.groups.size).toBe(4);
  });

  test("the same error in two projects is two groups (BAC-89)", async () => {
    const store = new MemoryStore();
    const sink = new DerivedErrorSink(store, limits, () => 0);
    await sink.flush("o", "dev", [err("db down")]);
    await sink.flush("o", "production", [err("db down"), err("db down")]);
    expect(store.groups.size).toBe(2);
    expect(store.groups.get(`o|dev|${err("db down").fingerprint}`)!.count).toBe(1);
    expect(store.groups.get(`o|production|${err("db down").fingerprint}`)!.count).toBe(2);
  });

  test("a group created before a restart is counted by update-only once the cap is used", async () => {
    const store = new MemoryStore();
    await new DerivedErrorSink(store, limits, () => 0).flush("o", "p", [err("old")]);
    const fresh = new DerivedErrorSink(store, { ...limits, newGroupsPerMinute: 0 }, () => 0);
    await fresh.flush("o", "p", [err("old"), err("new")]);
    expect(store.calls.update).toBe(1);
    expect(store.groups.get(`o|p|${err("old").fingerprint}`)!.count).toBe(2);
    expect(store.groups.size).toBe(1);
  });

  test("a throwing store never throws out of submit, and the failure is counted", async () => {
    const boom: DerivedErrorStore = {
      upsertGroups: async () => { throw new Error("db gone"); },
      updateGroups: async () => [],
      insertEvents: async () => undefined,
    };
    const warnings: string[] = [];
    const sink = new DerivedErrorSink(boom, limits, () => 0, (m) => warnings.push(m));
    expect(() => sink.submit("o", "p", [err("x")])).not.toThrow();
    await new Promise((r) => setTimeout(r, 5));
    expect(sink.stats.failed).toBe(1);
    expect(sink.running).toBe(0);
    expect(warnings.length).toBe(1);
  });

  test("pushes beyond the in-flight limit are skipped, not queued", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const slow: DerivedErrorStore = {
      upsertGroups: async (_o, _p, gs) => { await gate; return gs.map((g, i) => ({ id: `g${i}`, fingerprint: g.fingerprint, inserted: true })); },
      updateGroups: async () => [],
      insertEvents: async () => undefined,
    };
    const sink = new DerivedErrorSink(slow, limits, () => 0);
    sink.submit("o", "p", [err("a")]);
    sink.submit("o", "p", [err("b")]);
    sink.submit("o", "p", [err("c")]);
    expect(sink.running).toBe(2);
    expect(sink.stats.skippedBusy).toBe(1);
    release();
    await new Promise((r) => setTimeout(r, 5));
    expect(sink.running).toBe(0);
    expect(sink.stats.writes).toBe(2);
  });

  test("an empty push writes nothing", () => {
    const store = new MemoryStore();
    new DerivedErrorSink(store, limits, () => 0).submit("o", "p", []);
    expect(store.calls).toEqual({ upsert: 0, update: 0, events: 0 });
  });
});
