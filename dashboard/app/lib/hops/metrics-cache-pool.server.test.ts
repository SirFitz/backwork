// BAC-79: the cache hit ratio and connection wait queries, and the store share queries that must
// not count the new store series twice.
import { describe, expect, test } from "bun:test";
import snapshot from "./query-defaults.snapshot.json";
import { windowIncrease } from "./counter-window";
import {
  HealthChecks,
  PerfRange,
  cacheHitRatioQuery,
  dbWaitShareQuery,
  routesScope,
  routesTable,
  servicesScope,
  storeCallsPerRequestQuery,
  storeShareQuery,
  type PromClient,
} from "./metrics.server";
import type { Tenant } from "~/lib/tenant.server";

const SHOWN = HealthChecks.Shown;
// Health checks and monitors (BAC-80): the health-check matcher, then synthetic!="1".
const NOT_HEALTH = 'op!~"(?i)/(?:healthz|health|ready|live|livez|readyz|ping)",synthetic!="1"';
const ROUTE = ["service", "method", "op"];
let seq = 0;
const org = (): Tenant => ({ orgId: `org-cp-${++seq}`, platform: false });
type Sample = { metric: Record<string, string>; value: number };

describe("store share queries select db and cache only", () => {
  test("store share and calls per request carry store=~\"db|cache\" on the store selector", () => {
    for (const scope of [servicesScope(), routesScope("svc"), servicesScope(SHOWN)]) {
      const share = storeShareQuery(scope, PerfRange.H6);
      const calls = storeCallsPerRequestQuery(scope, PerfRange.H6);
      for (const q of [share, calls]) {
        for (const m of q.matchAll(/backwork_hop_store_(?:seconds|calls)_total\{([^}]*)\}/g)) expect(m[1]).toContain('store=~"db|cache"');
        expect(q).not.toContain("db_wait");
        expect(q).not.toContain("cache_hit");
      }
    }
  });

  test("apart from that matcher the share is main's query, character for character", () => {
    const now = storeShareQuery(servicesScope(), PerfRange.H1);
    expect(now.replaceAll('store=~"db|cache",', "")).toBe(snapshot.share);
  });

  // Every store series that existed before this change is store="db" or store="cache", so the
  // matcher selects exactly the series main's query summed: the figure cannot move. This replays
  // the selection over a set of series as VictoriaMetrics would.
  test("with the new series present the share equals the share before they existed", () => {
    const before: Sample[] = [
      { metric: { service: "svc", store: "db" }, value: 6.4 },
      { metric: { service: "svc", store: "cache" }, value: 0.9 },
    ];
    const after: Sample[] = [...before, { metric: { service: "svc", store: "db_wait" }, value: 4.2 }];
    const selected = (query: string, series: Sample[]): number => {
      const m = /backwork_hop_store_seconds_total\{[^}]*store=~"([^"]+)"/.exec(query);
      const allowed = m ? new Set(m[1].split("|")) : null;
      return series.filter((s) => allowed === null || allowed.has(s.metric.store)).reduce((a, s) => a + s.value, 0);
    };
    const mainQuery = snapshot.share;
    const newQuery = storeShareQuery(servicesScope(), PerfRange.H1);
    expect(selected(mainQuery, before)).toBeCloseTo(7.3, 9);
    expect(selected(newQuery, after)).toBe(selected(mainQuery, before));
    // Without the matcher the wait would have been counted twice.
    expect(selected(mainQuery, after)).toBeCloseTo(11.5, 9);
  });
});

describe("cache hit ratio and connection wait queries", () => {
  test("hits over reads, reads being hits and misses (never cache_n)", () => {
    const q = cacheHitRatioQuery(routesScope("shop-api", SHOWN), PerfRange.H1);
    expect(q.hits).toBe(windowIncrease(`backwork_hop_store_calls_total{service="shop-api",store="cache_hit"}`, "1h", ROUTE));
    expect(q.reads).toBe(windowIncrease(`backwork_hop_store_calls_total{service="shop-api",store=~"cache_hit|cache_miss"}`, "1h", ROUTE));
  });
  test("wait seconds over database seconds", () => {
    expect(dbWaitShareQuery(routesScope("svc", SHOWN), PerfRange.H6)).toBe(
      `${windowIncrease(`backwork_hop_store_seconds_total{service="svc",store="db_wait"}`, "6h", ROUTE)} / ${windowIncrease(`backwork_hop_store_seconds_total{service="svc",store="db"}`, "6h", ROUTE)}`,
    );
  });
  test("health checks are left out by default", () => {
    const q = cacheHitRatioQuery(routesScope("svc"), PerfRange.H1);
    expect(q.hits).toContain(`store="cache_hit",${NOT_HEALTH}}`);
    expect(dbWaitShareQuery(routesScope("svc"), PerfRange.H1)).toContain(`store="db_wait",${NOT_HEALTH}}`);
  });
  test("a hostile service name stays inside its string", () => {
    expect(cacheHitRatioQuery(routesScope('x"}) or vector(1) #', SHOWN), PerfRange.H1).hits).toContain('service="x\\"}) or vector(1) #"');
  });
});

describe("routesTable", () => {
  const r = (op: string, value: number): Sample => ({ metric: { service: "shop-api", method: "GET", op }, value });
  const client = (answers: Array<[RegExp, Sample[]]>): PromClient => ({
    async instant(q) {
      for (const [re, out] of answers) if (re.test(q)) return out;
      return [];
    },
    async range() {
      return [];
    },
  });
  test("ratio and wait per route; no data stays null, all misses is 0", async () => {
    const rows = await routesTable("shop-api", PerfRange.H1, org(), client([
      [/cache_hit\|cache_miss/, [r("/search", 100), r("/orders/:id", 30), r("/misses", 12)]],
      [/store="cache_hit"/, [r("/search", 30), r("/orders/:id", 20)]],
      [/store="db_wait"/, [r("/refunds", 0.72), r("/search", Number.NaN)]],
      [/store_seconds_total/, [r("/search", 0.2)]],
      [/histogram_quantile/, []],
      [/outcome|status_class/, []],
      [/_count/, [r("/search", 1), r("/orders/:id", 1), r("/misses", 1), r("/refunds", 1), r("/plain", 1)]],
    ]));
    const by = Object.fromEntries(rows.map((x) => [x.op, x]));
    expect(by["/search"].cacheHitRatio).toBeCloseTo(0.3, 9);
    expect(by["/orders/:id"].cacheHitRatio).toBeCloseTo(2 / 3, 9);
    expect(by["/misses"].cacheHitRatio).toBe(0);
    expect(by["/plain"].cacheHitRatio).toBeNull();
    expect(by["/refunds"].cacheHitRatio).toBeNull();
    expect(by["/refunds"].dbWaitShare).toBeCloseTo(0.72, 9);
    expect(by["/search"].dbWaitShare).toBeNull();
    expect(by["/plain"].dbWaitShare).toBeNull();
    expect(by["/search"].storeShare).toBe(0.2);
  });
});
