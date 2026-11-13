import { describe, expect, test } from "bun:test";
import { limitsFor } from "./limits";
import { expiryEnd, trimOrg, type BucketStore, type LokiOps } from "./retention.server";
import type { Bucket } from "./window";

const H = 3_600_000;
const NOW = Date.UTC(2026, 10, 13, 10, 30);
const free = limitsFor({ plan: "free", requestsLimit: null, storageLimitBytes: null })!;
const team = limitsFor({ plan: "team", requestsLimit: null, storageLimitBytes: null })!;

function fakes(buckets: Bucket[]): { loki: LokiOps; store: BucketStore; removed: Array<[string, number, number]>; pruned: number[] } {
  const removed: Array<[string, number, number]> = [];
  const pruned: number[] = [];
  return {
    removed, pruned,
    loki: { remove: async (q, s, e) => void removed.push([q, s, e]) },
    store: { load: async () => buckets, prune: async (_o, before) => void pruned.push(before) },
  };
}

describe("expiryEnd", () => {
  test("is now minus the days, rounded down to the hour, in unix seconds", () => {
    expect(expiryEnd(NOW, 3)).toBe(Date.UTC(2026, 10, 10, 10, 0) / 1000);
  });
});

describe("trimOrg", () => {
  const nowS = Math.floor(NOW / 1000);
  test("a window that fits only expires by age and prunes nothing", async () => {
    const f = fakes([{ startS: nowS - 600, requests: 10, bytes: 1000 }]);
    const r = await trimOrg("ORG", free, f.loki, f.store, NOW);
    expect(f.removed.map((x) => x[0])).toEqual(['{org_id="ORG",kind="hop"}', '{org_id="ORG",kind="log"}']);
    expect(r.cutoffS).toBeNull();
    expect(f.pruned).toEqual([]);
  });

  test("over the request cap: deletes everything older than the cut and forgets those counters", async () => {
    // newest 5-min bucket first: 60K, 60K -> the second would make 120K > 100K
    const f = fakes([
      { startS: nowS - 1800, requests: 60_000, bytes: 1 },
      { startS: nowS - 900, requests: 60_000, bytes: 1 },
      { startS: nowS - 600, requests: 60_000, bytes: 1 },
    ]);
    const r = await trimOrg("ORG", free, f.loki, f.store, NOW);
    expect(r.cutoffS).toBe(nowS - 600);
    expect(f.removed.at(-1)?.[0]).toBe('{org_id="ORG"}');
    expect(f.removed.at(-1)?.[2]).toBe(nowS - 600);
    expect(f.pruned).toEqual([nowS - 600]);
  });

  test("a repeat cut only re-asks for the stretch since the last one", async () => {
    const last = new Map<string, number>();
    const rows: Bucket[] = [{ startS: nowS - 900, requests: 90_000, bytes: 1 }, { startS: nowS - 600, requests: 90_000, bytes: 1 }];
    const a = fakes(rows);
    await trimOrg("ORG", free, a.loki, a.store, NOW, last);
    const b = fakes(rows);
    await trimOrg("ORG", free, b.loki, b.store, NOW + 600_000, last);
    const firstStart = a.removed.at(-1)![1];
    const secondStart = b.removed.at(-1)![1];
    expect(secondStart).toBeGreaterThan(firstStart);
    expect(secondStart).toBe(nowS - 600 - 2 * 3600);
  });

  test("a plan with no window is never cut by size", async () => {
    const f = fakes([{ startS: nowS - 600, requests: 1e9, bytes: 1e12 }]);
    const r = await trimOrg("ORG", team, f.loki, f.store, NOW);
    expect(r.cutoffS).toBeNull();
    expect(f.removed.map((x) => x[0])).toEqual(['{org_id="ORG",kind="hop"}', '{org_id="ORG",kind="log"}']);
  });
});
