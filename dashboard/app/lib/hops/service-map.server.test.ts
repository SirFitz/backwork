import { describe, expect, test } from "bun:test";
import { PerfRange } from "~/lib/hops/figures";
import type { PromClient } from "~/lib/hops/metrics.server";
import type { PeerPair } from "~/lib/hops/peers";
import type { LearnQueryFn, PeerStore } from "~/lib/hops/peers.server";
import { EdgeTone, NodeKind } from "~/lib/hops/service-map";
import { MAP_FRESH_MS, parseMapRange, serviceMap } from "~/lib/hops/service-map.server";
import type { Tenant } from "~/lib/tenant.server";

type Sample = { metric: Record<string, string>; value: number };

const SERVICES: Record<string, number> = { "shop-api": 2, "commerce-payments": 1, "commerce-risk": 0.5 };
/** Outbound calls as the shared fixture stack reports them: [service, peer, via, calls/s, failed share]. */
const CALLS: Array<[string, string, string, number, number]> = [
  ["shop-api", "payments.internal", "http", 0.5, 0],
  ["shop-api", "risk.internal", "http", 0.5, 0.02],
  ["shop-api", "shop-db", "db", 5, 0],
  ["shop-api", "redis.internal", "cache", 3, 0],
  ["commerce-risk", "redis.internal", "cache", 0.5, 0],
  ["commerce-payments", "payments-db", "db", 0.8, 0],
  ["commerce-payments", "acquirer.example", "http", 0.4, 0.1],
];

/** Answers the builders' queries by direction and kind; records how many queries ran. */
function fakeClient(): { client: PromClient; count: () => number } {
  let n = 0;
  const client: PromClient = {
    async instant(q) {
      n++;
      if (q.includes("last_over_time")) return Object.keys(SERVICES).map((service) => ({ metric: { service }, value: 1 }));
      const out = q.includes('dir="out"');
      const rows: Sample[] = [];
      if (q.includes("histogram_quantile")) {
        if (out) for (const [service, peer, via] of CALLS) rows.push({ metric: { service, peer, via }, value: 0.05 });
        else for (const service of Object.keys(SERVICES)) rows.push({ metric: { service }, value: 0.1 });
        return rows;
      }
      if (!q.includes("_count{")) return [];
      if (q.includes('outcome="error"')) {
        if (out) for (const [service, peer, via, rate, fail] of CALLS) rows.push({ metric: { service, peer, via }, value: rate * fail });
        return rows;
      }
      if (q.includes('status_class="5xx"')) return [];
      if (out) for (const [service, peer, via, rate] of CALLS) rows.push({ metric: { service, peer, via }, value: rate });
      else if (!q.includes("via")) for (const [service, rate] of Object.entries(SERVICES)) rows.push({ metric: { service }, value: rate });
      return rows;
    },
    async range() {
      n++;
      return [];
    },
  };
  return { client, count: () => n };
}

function store(pairs: PeerPair[] = []): PeerStore & { pairs: PeerPair[] } {
  const s = {
    pairs: [...pairs],
    async known() {
      return new Set<string>();
    },
    async save(_o: string, p: readonly PeerPair[]) {
      s.pairs.unshift(...p);
    },
    async all() {
      return [...s.pairs];
    },
  };
  return s;
}

const vectorLine = (fields: Record<string, string | boolean>): string =>
  JSON.stringify({ kind: "hop", message: JSON.stringify({ level: 30, msg: "hop", ...fields }), service: fields.service });
const TR = "e23d3f05431739f104968c32e9c9cdf1";
/** A checkout as the fixtures record it: shop-api calls both commerce services. */
const read: LearnQueryFn = async () =>
  [
    vectorLine({ trace_id: TR, hop: "out", hop_id: "8ab65808fba86570", parent_hop: "b69f27c2f6667398", service: "shop-api", via: "http", method: "POST", peer: "payments.internal" }),
    vectorLine({ trace_id: TR, hop: "out", hop_id: "7f4dbc07e9da4b0c", parent_hop: "b69f27c2f6667398", service: "shop-api", via: "http", method: "POST", peer: "risk.internal" }),
    vectorLine({ trace_id: TR, hop: "in", hop_id: "5d9e0b3347c1a2f8", parent_hop: "8ab65808fba86570", service: "commerce-payments", via: "http", method: "POST", op: "/charges" }),
    vectorLine({ trace_id: TR, hop: "in", hop_id: "6e0f1c4458d2b3a9", parent_hop: "7f4dbc07e9da4b0c", service: "commerce-risk", via: "http", method: "POST", op: "/score" }),
  ].map((line, i) => ({ ts: 1_794_633_000_000 + i, line, labels: { kind: "hop" } }));

describe("serviceMap", () => {
  test("with an empty peer table the scan resolves the checkout calls to services", async () => {
    const tenant: Tenant = { orgId: "map-test-1", platform: false };
    const peers = store();
    const m = await serviceMap(PerfRange.H1, tenant, fakeClient().client, peers, Date.now, read);
    expect(peers.pairs.length).toBe(2);
    const edges = m.edges.map((e) => `${e.from} -> ${e.to}`).sort();
    expect(edges).toEqual([
      "svc:commerce-payments -> ext:acquirer.example",
      "svc:commerce-payments -> store:payments-db",
      "svc:commerce-risk -> store:redis.internal",
      "svc:shop-api -> store:redis.internal",
      "svc:shop-api -> store:shop-db",
      "svc:shop-api -> svc:commerce-payments",
      "svc:shop-api -> svc:commerce-risk",
    ]);
    const kind = Object.fromEntries(m.nodes.map((n) => [n.id, n.kind]));
    expect(kind["ext:acquirer.example"]).toBe(NodeKind.External);
    expect(kind["store:redis.internal"]).toBe(NodeKind.Store);
    expect(m.unresolvedPeers).toBe(1);
    expect(m.edges.find((e) => e.to === "svc:commerce-risk")?.tone).toBe(EdgeTone.Warn);
    expect(m.edges.find((e) => e.to === "ext:acquirer.example")?.tone).toBe(EdgeTone.Err);
    const layer = Object.fromEntries(m.nodes.map((n) => [n.id, n.layer]));
    expect(layer["svc:shop-api"]).toBe(0);
    expect(layer["svc:commerce-payments"]).toBe(1);
    expect(layer["store:shop-db"]).toBe(3);
    expect(m.peersUnavailable).toBe(false);
  });

  test("a failing peer scan and store still give a map, with peers marked unavailable", async () => {
    const tenant: Tenant = { orgId: "map-test-2", platform: false };
    const broken: PeerStore = {
      known: async () => new Set(),
      save: async () => {},
      all: async () => {
        throw new Error("db down");
      },
    };
    const m = await serviceMap(PerfRange.H1, tenant, fakeClient().client, broken, Date.now, async () => {
      throw new Error("loki down");
    });
    expect(m.peersUnavailable).toBe(true);
    expect(m.edges.find((e) => e.from === "svc:shop-api" && e.to === "ext:payments.internal")).toBeDefined();
  });

  test("a fresh map is served from the cache", async () => {
    const tenant: Tenant = { orgId: "map-test-3", platform: false };
    const fake = fakeClient();
    let clock = 5_000_000;
    const first = await serviceMap(PerfRange.H6, tenant, fake.client, store(), () => clock, read);
    const ran = fake.count();
    clock += MAP_FRESH_MS - 1;
    const second = await serviceMap(PerfRange.H6, tenant, fake.client, store(), () => clock, read);
    expect(fake.count()).toBe(ran);
    expect(second.computedAt).toBe(first.computedAt);
  });

  test("ranges are 1h, 6h and 24h", () => {
    expect(parseMapRange("6h")).toBe(PerfRange.H6);
    expect(parseMapRange("7d")).toBe(PerfRange.H1);
    expect(parseMapRange(null)).toBe(PerfRange.H1);
  });
});
