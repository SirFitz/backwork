import { describe, expect, test } from "bun:test";
import { calledPeers, peerPairs } from "./peers";
import { knownPeersFor, type PeerStore } from "./peers.server";
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
    };
  };
  test("saves the pairs and answers the known peers among those called", async () => {
    const s = store(["old.internal"]);
    const got = await knownPeersFor("org", [{ peer: "payments.internal", service: "commerce-payments" }], ["old.internal", "kms.amazonaws.com"], s);
    expect(got).toEqual(["old.internal", "payments.internal"]);
    expect(s.saved.length).toBe(1);
  });
  test("a failing store answers null (could not tell)", async () => {
    const failing: PeerStore = { known: async () => { throw new Error("db down"); }, save: async () => {} };
    expect(await knownPeersFor("org", [], ["x"], failing)).toBeNull();
  });
});
