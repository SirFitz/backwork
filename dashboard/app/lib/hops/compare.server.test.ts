import { describe, expect, test } from "bun:test";
import {
  CompareVerdict,
  compareRoutes,
  compareServices,
  serviceRegressions,
  serviceTrend,
  serviceTrendQuery,
  trendChartStepSeconds,
} from "./compare.server";
import { PerfRange, Quantile, quantileQuery, rateQuery, servicesScope, type PromClient } from "./metrics.server";
import { HealthChecks } from "./health";
import type { Tenant } from "~/lib/tenant.server";
import type { Deploy } from "~/lib/deploys";

let orgSeq = 0;
function org(): Tenant {
  orgSeq += 1;
  return { orgId: `org-compare-${orgSeq}`, platform: false };
}

type Sample = { metric: Record<string, string>; value: number };
type Range = { metric: Record<string, string>; points: Array<{ t: number; v: number }> };

/** Last week's queries carry `offset 604800s`; everything else is the current window. */
const LAST_WEEK = /offset 604800s/;

interface Window {
  rate: Sample[];
  errA: Sample[];
  p95: Sample[];
}

function fake(now: Window, before: Window | null, ranges: { now?: Range[]; before?: Range[] } = {}) {
  const seen: string[] = [];
  const pick = (q: string): Window | null => (LAST_WEEK.test(q) ? before : now);
  const client: PromClient = {
    async instant(q) {
      seen.push(q);
      const w = pick(q);
      if (!w) return [];
      if (q.startsWith("histogram_quantile(0.95")) return w.p95;
      if (q.startsWith("histogram_quantile")) return [];
      if (q.includes('outcome="error"')) return w.errA;
      if (q.includes("status_class")) return [];
      return w.rate;
    },
    async range(q) {
      seen.push(q);
      return (LAST_WEEK.test(q) ? ranges.before : ranges.now) ?? [];
    },
  };
  return { client, seen };
}

const svc = (service: string, value: number): Sample => ({ metric: { service }, value });
const route = (service: string, method: string, op: string, value: number): Sample => ({ metric: { service, method, op }, value });

describe("query strings", () => {
  test("last week is offset 7d with the shortened lookback, per range", () => {
    const cases: Array<[PerfRange, number, number]> = [
      [PerfRange.H1, 3600, 7 * 86400 - 2 * 3600],
      [PerfRange.H6, 21600, 7 * 86400 - 7 * 3600],
      [PerfRange.H24, 86400, 7 * 86400 - 25 * 3600],
    ];
    for (const [range, w, lb] of cases) {
      const q = rateQuery("in", servicesScope(), range, "7d", lb);
      expect(q).toContain(`[${w + lb}s] offset 604800s`);
      expect(q).toContain(`[${lb}s] offset ${604800 + w}s`);
    }
  });

  test("the current window keeps the tables' queries; 12 queries per compare", async () => {
    const { client, seen } = fake({ rate: [svc("a", 1)], errA: [], p95: [svc("a", 0.2)] }, null);
    await compareServices(PerfRange.H6, org(), client);
    expect(seen).toHaveLength(12);
    const current = seen.filter((q) => !LAST_WEEK.test(q));
    expect(current).toContain(rateQuery("in", servicesScope(), PerfRange.H6));
    expect(current).toContain(quantileQuery(Quantile.P95, "in", servicesScope(), PerfRange.H6));
    expect(seen.filter((q) => LAST_WEEK.test(q))).toHaveLength(6);
  });

  test("7d is refused without a query", async () => {
    const { client, seen } = fake({ rate: [svc("a", 1)], errA: [], p95: [] }, null);
    expect(await compareServices(PerfRange.D7, org(), client)).toEqual([]);
    expect(await compareRoutes("a", PerfRange.D7, org(), client)).toEqual([]);
    expect(seen).toHaveLength(0);
  });

  test("a service name that is not a label value never reaches a query", async () => {
    const { client, seen } = fake({ rate: [], errA: [], p95: [] }, null);
    expect(await compareRoutes('a"} or vector(1) #', PerfRange.H1, org(), client)).toEqual([]);
    expect(await compareRoutes("has space", PerfRange.H1, org(), client)).toEqual([]);
    expect(seen).toHaveLength(0);
  });

  test("routes are scoped to the service", async () => {
    const { client, seen } = fake({ rate: [], errA: [], p95: [] }, null);
    await compareRoutes("shop-api", PerfRange.H1, org(), client);
    expect(seen.every((q) => q.includes('service="shop-api"'))).toBe(true);
    expect(seen.every((q) => q.includes("by (service, method, op"))).toBe(true);
  });

  test("the trend's last-week query has the offset and the step as inner window", () => {
    expect(trendChartStepSeconds(PerfRange.H1)).toBe(75);
    expect(trendChartStepSeconds(PerfRange.H6)).toBe(450);
    const q = serviceTrendQuery("shop-api", PerfRange.H6, HealthChecks.Hidden, "7d", 7 * 86400 - 7 * 3600);
    expect(q).toContain(`[${450 + 579600}s] offset 604800s`);
    expect(q).toContain('service="shop-api"');
    expect(serviceTrendQuery("shop-api", PerfRange.H6)).not.toContain("offset 604800s");
  });
});

describe("compare", () => {
  test("joins now and last week by service, with requests over the range", async () => {
    const { client } = fake(
      { rate: [svc("shop-api", 1), svc("new-api", 1)], errA: [], p95: [svc("shop-api", 0.74), svc("new-api", 0.1)] },
      { rate: [svc("shop-api", 1)], errA: [], p95: [svc("shop-api", 0.31)] },
    );
    const rows = await compareServices(PerfRange.H1, org(), client);
    const shop = rows.find((r) => r.service === "shop-api");
    expect(shop?.verdict).toBe(CompareVerdict.Slower);
    expect(shop?.requestsNow).toBe(3600);
    expect(shop?.method).toBeNull();
    expect(rows.find((r) => r.service === "new-api")?.verdict).toBe(CompareVerdict.NoBaseline);
  });

  test("routes: last week absent gives no baseline", async () => {
    const { client } = fake({ rate: [route("shop-api", "GET", "/shop", 1)], errA: [], p95: [route("shop-api", "GET", "/shop", 0.066)] }, null);
    const rows = await compareRoutes("shop-api", PerfRange.H1, org(), client);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ method: "GET", op: "/shop", before: null, verdict: CompareVerdict.NoBaseline });
  });

  test("cached for 30 seconds per org and range", async () => {
    const { client, seen } = fake({ rate: [svc("a", 1)], errA: [], p95: [] }, null);
    const t = org();
    await compareServices(PerfRange.H1, t, client);
    await compareServices(PerfRange.H1, t, client);
    expect(seen).toHaveLength(12);
    await compareServices(PerfRange.H6, t, client);
    expect(seen).toHaveLength(24);
  });
});

describe("trend", () => {
  const NOW = 1_800_000_000_000;
  test("now and last week at the same instants; 7d has no last week", async () => {
    const pts = (v: number): Range[] => [{ metric: { service: "shop-api" }, points: [{ t: NOW - 60_000, v }, { t: NOW, v: Number.NaN }] }];
    const { client, seen } = fake({ rate: [], errA: [], p95: [] }, null, { now: pts(0.07), before: pts(0.03) });
    const t = await serviceTrend("shop-api", PerfRange.H1, org(), client, NOW);
    expect(t.now).toEqual([{ t: NOW - 60_000, v: 0.07 }]);
    expect(t.lastWeek).toEqual([{ t: NOW - 60_000, v: 0.03 }]);
    expect(t.end - t.start).toBe(3600_000);
    const week = await serviceTrend("shop-api", PerfRange.D7, org(), client, NOW);
    expect(week.lastWeek).toBeNull();
    expect(seen.filter((q) => LAST_WEEK.test(q))).toHaveLength(1);
  });
});

describe("serviceRegressions", () => {
  const NOW = 1_800_000_000_000;
  const deploy = (service: string, at: number, version: string): Deploy => ({
    id: version, projectId: null, service, version, commit: null, environment: null, url: null, actor: null, deployedAt: at,
  });
  test("slower services with the newest deploy of the last 7 hours", async () => {
    const { client } = fake(
      { rate: [svc("shop-api", 1), svc("calm", 1)], errA: [], p95: [svc("shop-api", 0.74), svc("calm", 0.1)] },
      { rate: [svc("shop-api", 1), svc("calm", 1)], errA: [], p95: [svc("shop-api", 0.31), svc("calm", 0.1)] },
    );
    const asked: Array<[number, number]> = [];
    const read = async (_org: string, _s: string | null, from: number, to: number): Promise<Deploy[]> => {
      asked.push([from, to]);
      return [deploy("shop-api", NOW - 3 * 3600_000, "v1"), deploy("shop-api", NOW - 22 * 60_000, "v2"), deploy("calm", NOW - 60_000, "v9")];
    };
    const rows = await serviceRegressions(org(), client, NOW, read);
    expect(asked).toEqual([[NOW - 7 * 3600_000, NOW]]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ service: "shop-api", verdict: "slower", deployLabel: "v2", deployAt: NOW - 22 * 60_000, requests: 3600 });
  });
  test("nothing slower reads no deploys", async () => {
    const { client } = fake({ rate: [svc("calm", 1)], errA: [], p95: [svc("calm", 0.1)] }, { rate: [svc("calm", 1)], errA: [], p95: [svc("calm", 0.1)] });
    let reads = 0;
    const rows = await serviceRegressions(org(), client, NOW, async () => { reads++; return []; });
    expect(rows).toEqual([]);
    expect(reads).toBe(0);
  });
});
