import { describe, expect, test } from "bun:test";
import { limitsFor } from "./limits";
import { capCutoff, expiryEnd, purgeOrg, type LokiOps, type VolumePoint } from "./retention.server";

const H = 3_600_000;
const NOW = Date.UTC(2026, 10, 13, 10, 30);

describe("expiryEnd", () => {
  test("is now minus the days, rounded down to the hour, in unix seconds", () => {
    expect(expiryEnd(NOW, 3)).toBe(Date.UTC(2026, 10, 10, 10, 0) / 1000);
  });
});

describe("capCutoff", () => {
  const hours = (bytes: number[]): VolumePoint[] => bytes.map((b, i) => ({ tsMs: i * H, bytes: b }));
  test("null when it all fits", () => expect(capCutoff(hours([10, 10, 10]), 100)).toBeNull());
  test("keeps the newest buckets within 90% of the cap", () => {
    // newest first: 40, 40 (=80 <= 90), then 40 would make 120 > 90
    expect(capCutoff(hours([40, 40, 40, 40]), 100)).toBe(2 * H);
  });
  test("one bucket bigger than the cap keeps only the newest bucket", () => {
    expect(capCutoff(hours([50, 500]), 100)).toBe(1 * H);
  });
});

describe("purgeOrg", () => {
  const free = limitsFor({ plan: "free", requestsLimit: null, storageLimitBytes: null })!;
  function fake(points: VolumePoint[]): { ops: LokiOps; removed: Array<[string, number, number]> } {
    const removed: Array<[string, number, number]> = [];
    return { removed, ops: { volume: async () => points, remove: async (q, s, e) => void removed.push([q, s, e]) } };
  }
  test("expires hops and logs by age and does not trim when under the cap", async () => {
    const f = fake([{ tsMs: NOW - H, bytes: 1000 }]);
    const r = await purgeOrg("ORG", free, f.ops, NOW);
    expect(f.removed.map((x) => x[0])).toEqual(['{org_id="ORG",kind="hop"}', '{org_id="ORG",kind="log"}']);
    expect(r.capCutoffMs).toBeNull();
  });
  test("trims the oldest hours when over the cap", async () => {
    const f = fake([{ tsMs: NOW - 3 * H, bytes: 900 * 1024 ** 2 }, { tsMs: NOW - 2 * H, bytes: 900 * 1024 ** 2 }, { tsMs: NOW - H, bytes: 100 * 1024 ** 2 }]);
    const r = await purgeOrg("ORG", free, f.ops, NOW);
    expect(r.capCutoffMs).toBe(NOW - H);
    expect(f.removed.at(-1)).toEqual(['{org_id="ORG"}', Math.floor((NOW - 30 * 24 * H) / 86_400_000) * 86400, Math.floor((NOW - H) / 1000)]);
  });
});
