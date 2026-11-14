import { describe, expect, test } from "bun:test";
import { calledPeers, peerPairs } from "./peers";
import {
  LEARN_EVERY_MS,
  LEARN_RECORDS_QUERY,
  LEARN_RECORD_LIMIT,
  knownPeersFor,
  learnPeers,
  peerServicesFor,
  scanPeers,
  type LearnQueryFn,
  type PeerStore,
} from "./peers.server";
import type { PeerPair } from "./peers";
import type { Tenant } from "~/lib/tenant.server";
import { parseHopRecord } from "./parse";
import type { HopRecord } from "./types";

const T = "6503f5f183b828139d5b143365ad72fa";
const rec = (line: string, service = "commerce-api"): HopRecord => {
  const r = parseHopRecord({ ts: 1_700_000_000_000, line, labels: { service } });
  if (!r) throw new Error(line);
  return r;
};
const OUT = `trace_id=${T} hop=out_end hop_id=83c2d1907ae45b16 parent_hop=1f0a6c2e9b7d4405 hop_sent=true parent_id=b7ad6b7169203331 service=commerce-api adapter=finch via=http method=POST peer=payments.internal outcome=ok status=201 duration_us=1000`;
const IN = `trace_id=${T} hop=in hop_id=5d9e0b3347c1a2f8 parent_hop=83c2d1907ae45b16 parent_id=b7ad6b7169203331 service=commerce-payments adapter=hono via=http method=POST op=/charges`;
const DB = `trace_id=${T} hop=out_end hop_id=93c2d1907ae45b16 parent_hop=1f0a6c2e9b7d4405 hop_sent=false parent_id=b7ad6b7169203331 service=commerce-api adapter=pg via=db op=select peer=orders-db outcome=ok duration_us=100`;
const AWS = `trace_id=${T} hop=out_end hop_id=a3c2d1907ae45b16 parent_hop=1f0a6c2e9b7d4405 hop_sent=true parent_id=b7ad6b7169203331 service=commerce-api adapter=finch via=http method=POST peer=kms.amazonaws.com outcome=ok status=200 duration_us=1000`;

describe("peerPairs", () => {
  test("an outbound hop and the inbound hop it reached make a pair; stores and unanswered calls do not", () => {
    const records = [rec(OUT), rec(IN, "commerce-payments"), rec(DB), rec(AWS)];
    expect(peerPairs(records)).toEqual([{ peer: "payments.internal", service: "commerce-payments" }]);
    expect(calledPeers(records).sort()).toEqual(["kms.amazonaws.com", "payments.internal"]);
  });
});

describe("knownPeersFor", () => {
  const store = (known: string[]): PeerStore & { saved: unknown[] } => {
    const saved: unknown[] = [];
    return {
      saved,
      async known(_o, peers) {
        return new Set(peers.filter((p) => known.includes(p)));
      },
      async save(_o, pairs) {
        saved.push(...pairs);
      },
      async all() {
        return [];
      },
    };
  };
  test("saves the pairs and answers the known peers among those called", async () => {
    const s = store(["old.internal"]);
    const got = await knownPeersFor("org", [{ peer: "payments.internal", service: "commerce-payments" }], ["old.internal", "kms.amazonaws.com"], s);
    expect(got).toEqual(["old.internal", "payments.internal"]);
    expect(s.saved.length).toBe(1);
  });
  test("a failing store answers null (could not tell)", async () => {
    const failing: PeerStore = { known: async () => { throw new Error("db down"); }, save: async () => {}, all: async () => [] };
    expect(await knownPeersFor("org", [], ["x"], failing)).toBeNull();
  });
});

// Records as the shared fixture stack stores them: Vector's JSON envelope around the pino line.
const vectorLine = (fields: Record<string, string | number | boolean>): string =>
  JSON.stringify({ display: "hop", kind: "hop", level: "info", message: JSON.stringify({ level: 30, time: 1_794_633_338_002, msg: "hop", ...fields }), service: fields.service, source: fields.service });
const TR = "e23d3f05431739f104968c32e9c9cdf1";
const CHECKOUT: Array<{ line: string; service: string }> = [
  { service: "shop-api", line: vectorLine({ trace_id: TR, hop: "in", hop_id: "b69f27c2f6667398", parent_id: "9b2fc32c9d03e72d", service: "shop-api", adapter: "express", via: "http", method: "POST", op: "/checkout" }) },
  { service: "shop-api", line: vectorLine({ trace_id: TR, hop: "out", hop_id: "8ab65808fba86570", parent_hop: "b69f27c2f6667398", hop_sent: true, parent_id: "9b2fc32c9d03e72d", service: "shop-api", adapter: "undici", via: "http", method: "POST", peer: "payments.internal" }) },
  { service: "shop-api", line: vectorLine({ trace_id: TR, hop: "out_end", hop_id: "7f4dbc07e9da4b0c", parent_hop: "b69f27c2f6667398", hop_sent: true, parent_id: "9b2fc32c9d03e72d", service: "shop-api", adapter: "undici", via: "http", method: "POST", peer: "risk.internal", outcome: "ok", status: 200, duration_us: 36677 }) },
  { service: "shop-api", line: vectorLine({ trace_id: TR, hop: "out_end", hop_id: "11aa22bb33cc44dd", parent_hop: "b69f27c2f6667398", hop_sent: false, parent_id: "9b2fc32c9d03e72d", service: "shop-api", adapter: "pg", via: "db", op: "select", peer: "shop-db", outcome: "ok", duration_us: 900 }) },
  { service: "commerce-payments", line: vectorLine({ trace_id: TR, hop: "in", hop_id: "5d9e0b3347c1a2f8", parent_hop: "8ab65808fba86570", parent_id: "9b2fc32c9d03e72d", service: "commerce-payments", adapter: "hono", via: "http", method: "POST", op: "/charges" }) },
  { service: "commerce-risk", line: vectorLine({ trace_id: TR, hop: "in_end", hop_id: "6e0f1c4458d2b3a9", parent_hop: "7f4dbc07e9da4b0c", parent_id: "9b2fc32c9d03e72d", service: "commerce-risk", adapter: "hono", via: "http", method: "POST", op: "/score", outcome: "ok", status: 200, duration_us: 30000 }) },
];

const TENANT: Tenant = { orgId: "org-learn", platform: false };

function memoryStore(initial: PeerPair[] = []): PeerStore & { pairs: PeerPair[]; saves: number } {
  const s = {
    pairs: [...initial],
    saves: 0,
    async known(_o: string, peers: readonly string[]) {
      return new Set(peers.filter((p) => s.pairs.some((x) => x.peer === p)));
    },
    async save(_o: string, pairs: readonly PeerPair[]) {
      s.saves++;
      s.pairs.unshift(...pairs);
    },
    async all() {
      return [...s.pairs];
    },
  };
  return s;
}

describe("learnPeers", () => {
  const reads: string[] = [];
  const read: LearnQueryFn = async (query, opts) => {
    reads.push(query);
    expect(opts.limit).toBe(LEARN_RECORD_LIMIT);
    return CHECKOUT.map((c, i) => ({ ts: 1_794_633_338_000 + i, line: c.line, labels: { service: c.service, kind: "hop" } }));
  };

  test("a scan of realistic records links the checkout calls to the services that answered", async () => {
    const store = memoryStore();
    const got = await scanPeers(TENANT, read, store, 1_794_633_400_000);
    expect(store.pairs.sort((a, b) => a.peer.localeCompare(b.peer))).toEqual([
      { peer: "payments.internal", service: "commerce-payments" },
      { peer: "risk.internal", service: "commerce-risk" },
    ]);
    expect(got).toMatchObject({ records: 6, pairs: 2, saved: 2, truncated: false });
    expect(reads.at(-1)).toBe(LEARN_RECORDS_QUERY);
  });

  test("saves only the pairs not stored yet", async () => {
    const store = memoryStore([{ peer: "payments.internal", service: "commerce-payments" }]);
    const got = await scanPeers(TENANT, read, store);
    expect(got.saved).toBe(1);
    expect(store.pairs.length).toBe(2);
    const again = await scanPeers(TENANT, read, store);
    expect(again.saved).toBe(0);
    expect(store.saves).toBe(1);
  });

  test("scans at most once per five minutes per organisation", async () => {
    const store = memoryStore();
    let clock = 1_000_000;
    let scans = 0;
    const counting: LearnQueryFn = async (q, o, t) => {
      scans++;
      return read(q, o, t);
    };
    const tenant: Tenant = { orgId: "org-learn-once", platform: false };
    await learnPeers(tenant, counting, store, () => clock);
    clock += LEARN_EVERY_MS - 1;
    await learnPeers(tenant, counting, store, () => clock);
    expect(scans).toBe(1);
    clock += 2;
    await learnPeers(tenant, counting, store, () => clock);
    await Promise.resolve();
    expect(scans).toBe(2);
  });

  test("peerServicesFor maps each peer to its most recently seen service", async () => {
    const store = memoryStore([
      { peer: "pay.internal", service: "payments-v2" },
      { peer: "pay.internal", service: "payments" },
      { peer: "risk.internal", service: "risk" },
    ]);
    const map = await peerServicesFor("org-bulk-read", store);
    expect([...map.entries()]).toEqual([["pay.internal", "payments-v2"], ["risk.internal", "risk"]]);
  });
});
