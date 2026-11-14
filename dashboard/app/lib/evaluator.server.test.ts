import { describe, expect, test } from "bun:test";
import { AlertMetric, Comparator, type AlertRule } from "./alert-kinds";
import type { RuleReading } from "./alert-queries";
import { SEND_RETRY_MS, SLOW_QUERY_EVAL_MS, createEvaluator, type EvaluatorDeps } from "./evaluator.server";
import type { Channel, Msg } from "./channels.server";
import type { Delivered, StoredAlertState } from "./alert-state.server";

const MIN = 60_000;
const T0 = Date.UTC(2026, 10, 14, 12, 0, 0);

const rule: AlertRule = {
  id: "r1", name: "slow orders", metric: AlertMetric.RouteP95, service: "shop-api", comparator: Comparator.Above, threshold: 300,
  channelIds: ["c1"], enabled: true, route: { method: "GET", op: "/orders/:id" }, window: "15m", forMinutes: 2,
};
const hook: Channel = { id: "c1", name: "hook", type: "webhook", enabled: true, config: { url: "http://localhost:1/x" } };

/** One Postgres stand-in shared by every evaluator: the claim is atomic as in alert-state.server.ts. */
function store() {
  const states = new Map<string, StoredAlertState>();
  const events: Array<{ id: string; kind: string; delivered: Delivered | null }> = [];
  return {
    states,
    events,
    load: async () => new Map([...states].map(([k, v]) => [k, { ...v }])),
    setPending: async (_o: string, ruleId: string, pendingSince: number | null, value: number | null) => {
      const s = states.get(ruleId) ?? { firing: false, pendingSince: null, value: null, since: null, lastNotifiedAt: null };
      if (s.firing) return;
      states.set(ruleId, { ...s, pendingSince: pendingSince === null ? null : (s.pendingSince ?? pendingSince), value });
    },
    claim: async (_o: string, ruleId: string, firing: boolean, value: number | null, now: number) => {
      const s = states.get(ruleId);
      if ((s?.firing ?? false) === firing) return null;
      if (!firing && !s) return null;
      states.set(ruleId, { firing, pendingSince: null, value, since: now, lastNotifiedAt: now });
      const id = `e${events.length + 1}`;
      events.push({ id, kind: firing ? "firing" : "resolved", delivered: null });
      return { eventId: id, state: states.get(ruleId)! };
    },
    record: async (_o: string, eventId: string, d: Delivered) => {
      const e = events.find((x) => x.id === eventId)!;
      e.delivered = { ...(e.delivered ?? {}), ...d };
    },
  };
}

function setup(readings: () => RuleReading, rules: AlertRule[] = [rule], sendOk: () => boolean = () => true) {
  const db = store();
  const sent: Msg[] = [];
  const later: Array<() => void> = [];
  let now = T0;
  const make = (): EvaluatorDeps => ({
    orgs: async () => ["org-1"],
    rules: async () => rules,
    states: db.load,
    read: async () => readings(),
    setPending: db.setPending,
    claim: db.claim,
    recordDelivery: db.record,
    channels: async () => [hook],
    send: async (_c, m) => {
      sent.push(m);
      return sendOk() ? { ok: true } : { ok: false, error: "HTTP 500" };
    },
    deploy: async () => null,
    now: () => now,
    publicUrl: "http://localhost:3503",
    later: (fn, ms) => {
      expect(ms).toBe(SEND_RETRY_MS);
      later.push(fn);
    },
  });
  return { db, sent, later, make, advance: (ms: number) => (now += ms) };
}

describe("evaluator", () => {
  test("fires after the pending period, once, even with two processes ticking together", async () => {
    let value = 480;
    const s = setup(() => ({ value, noData: false, requests: 75 }));
    const a = createEvaluator(s.make());
    const b = createEvaluator(s.make());
    for (let i = 0; i < 5; i++) {
      await Promise.all([a.tick(), b.tick()]);
      s.advance(MIN);
    }
    expect(s.sent.map((m) => m.title)).toEqual(["FIRING: slow orders"]);
    expect(s.sent[0].link).toBe("http://localhost:3503/performance?service=shop-api");
    value = 90;
    await Promise.all([a.tick(), b.tick()]);
    await Promise.all([a.tick(), b.tick()]);
    expect(s.sent.map((m) => m.title)).toEqual(["FIRING: slow orders", "RESOLVED: slow orders"]);
    expect(s.db.events.map((e) => [e.kind, e.delivered])).toEqual([["firing", { c1: "ok" }], ["resolved", { c1: "ok" }]]);
  });

  test("a restart carries on from the stored state: no repeat, and a resolve during the gap is sent", async () => {
    let value = 480;
    const s = setup(() => ({ value, noData: false, requests: 75 }));
    const first = createEvaluator(s.make());
    for (let i = 0; i < 3; i++) {
      await first.tick();
      s.advance(MIN);
    }
    expect(s.sent).toHaveLength(1);
    const restarted = createEvaluator(s.make());
    await restarted.tick();
    expect(s.sent).toHaveLength(1);
    value = 90;
    const again = createEvaluator(s.make());
    await again.tick();
    expect(s.sent.map((m) => m.title)).toEqual(["FIRING: slow orders", "RESOLVED: slow orders"]);
  });

  test("no data changes nothing", async () => {
    const s = setup(() => ({ value: 0, noData: true }));
    const e = createEvaluator(s.make());
    await e.tick();
    expect(s.db.states.size).toBe(0);
    expect(s.sent).toHaveLength(0);
  });

  test("a failed send is recorded and tried once more", async () => {
    let ok = false;
    const s = setup(() => ({ value: 480, noData: false, requests: 75 }), [{ ...rule, forMinutes: 0 }], () => ok);
    await createEvaluator(s.make()).tick();
    expect(s.db.events[0].delivered).toEqual({ c1: "HTTP 500" });
    expect(s.later).toHaveLength(1);
    ok = true;
    s.later[0]();
    await new Promise((r) => setTimeout(r, 5));
    expect(s.db.events[0].delivered).toEqual({ c1: "ok" });
    expect(s.sent).toHaveLength(2);
  });

  test("slow query rules are read at most once per 5 minutes per organisation", async () => {
    let reads = 0;
    const slow: AlertRule = { ...rule, metric: AlertMetric.SlowQuery, route: undefined, service: "*", shape: "any" };
    const s = setup(() => {
      reads += 1;
      return { value: 0, noData: true };
    }, [slow]);
    const e = createEvaluator(s.make());
    for (let i = 0; i < 6; i++) {
      await e.tick();
      s.advance(MIN);
    }
    expect(reads).toBe(2);
    expect(SLOW_QUERY_EVAL_MS).toBe(5 * MIN);
  });

  test("disabled and retired rules are not read", async () => {
    let reads = 0;
    const s = setup(() => {
      reads += 1;
      return { value: 999, noData: false };
    }, [{ ...rule, enabled: false }, { ...rule, id: "r2", metric: "cpu", retired: "x" }]);
    await createEvaluator(s.make()).tick();
    expect(reads).toBe(0);
  });
});
