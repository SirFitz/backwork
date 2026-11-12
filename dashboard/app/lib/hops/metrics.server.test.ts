import { describe, expect, test } from "bun:test";
import {
  PerfRange,
  PeerKind,
  Quantile,
  combineFigures,
  connectionsScope,
  connectionsTable,
  defaultService,
  errorRateQueries,
  httpP95Query,
  httpTotalsQuery,
  inProgressQuery,
  inboundServices,
  inboundHttpTotals,
  isLabelValue,
  parseRange,
  peerKindOf,
  promString,
  quantileQuery,
  rateQuery,
  routesScope,
  routesTable,
  servicesScope,
  servicesTable,
  sortConnections,
  storeCallsPerRequestQuery,
  storeShareQuery,
  trendQuery,
  trendStep,
  windowSeconds,
  type ConnectionRow,
  type PromClient,
  type ServiceRow,
} from "./metrics.server";
import type { Tenant } from "~/lib/tenant.server";
import { HealthChecks } from "./health";
import { windowIncrease } from "./counter-window";

const SHOWN = HealthChecks.Shown;

let orgSeq = 0;
/** A fresh org per test, so the 10-second cache never serves one test's answer to another. */
function org(): Tenant {
  orgSeq += 1;
  return { orgId: `org-test-${orgSeq}`, platform: false };
}

type Sample = { metric: Record<string, string>; value: number };

/** A client that answers by matching a substring of the query. Records every query it saw. */
function fakeClient(answers: Array<[RegExp, Sample[]]>, ranges: Array<[RegExp, Array<{ metric: Record<string, string>; points: Array<{ t: number; v: number }> }>]> = []) {
  const seen: string[] = [];
  const client: PromClient = {
    async instant(q) {
      seen.push(q);
      for (const [re, out] of answers) if (re.test(q)) return out;
      return [];
    },
    async range(q) {
      seen.push(q);
      for (const [re, out] of ranges) if (re.test(q)) return out;
      return [];
    },
  };
  return { client, seen };
}

describe("parseRange", () => {
  test("accepts the four ranges", () => {
    for (const r of ["1h", "6h", "24h", "7d"]) expect(parseRange(r)).toBe(r as PerfRange);
  });
  test("falls back to 6h for anything else", () => {
    expect(parseRange(null)).toBe(PerfRange.H6);
    expect(parseRange("")).toBe(PerfRange.H6);
    expect(parseRange("30d")).toBe(PerfRange.H6);
    expect(parseRange("1h]) or vector(1")).toBe(PerfRange.H6);
  });
});

describe("isLabelValue (spec HOP-12)", () => {
  test("1 and 200 bytes of printable ASCII pass", () => {
    expect(isLabelValue("a")).toBe(true);
    expect(isLabelValue("x".repeat(200))).toBe(true);
    expect(isLabelValue("commerce-api")).toBe(true);
  });
  test("empty, 201 bytes, spaces, controls and non-ASCII fail", () => {
    expect(isLabelValue("")).toBe(false);
    expect(isLabelValue("x".repeat(201))).toBe(false);
    expect(isLabelValue("a b")).toBe(false);
    expect(isLabelValue("a\nb")).toBe(false);
    expect(isLabelValue("café")).toBe(false);
  });
});

describe("promString", () => {
  test("escapes quotes and backslashes", () => {
    expect(promString('a"b\\c')).toBe('"a\\"b\\\\c"');
  });
});

const wi = (sel: string, w: string, labels: string[]): string => windowIncrease(sel, w, labels);

describe("query builders (design 8.1)", () => {
  test("service request rate", () => {
    expect(rateQuery("in", servicesScope(SHOWN), PerfRange.H6)).toBe(
      `${wi(`backwork_hop_duration_seconds_count{dir="in"}`, "6h", ["service"])} / 21600`
    );
  });
  test("route request rate is filtered to the service", () => {
    expect(rateQuery("in", routesScope("commerce-payments", SHOWN), PerfRange.H1)).toBe(
      `${wi(`backwork_hop_duration_seconds_count{dir="in",service="commerce-payments"}`, "1h", ["service", "method", "op"])} / 3600`
    );
  });
  test("connections rate is outbound by service, peer and via", () => {
    expect(rateQuery("out", connectionsScope(), PerfRange.D7)).toBe(
      `${wi(`backwork_hop_duration_seconds_count{dir="out"}`, "7d", ["service", "peer", "via"])} / 604800`
    );
  });
  test("error rate is two disjoint selectors", () => {
    const [a, b] = errorRateQueries("in", servicesScope(SHOWN), PerfRange.H24);
    expect(a).toBe(`${wi(`backwork_hop_duration_seconds_count{dir="in",outcome="error"}`, "24h", ["service"])} / 86400`);
    expect(b).toBe(
      `${wi(`backwork_hop_duration_seconds_count{dir="in",outcome!="error",status_class="5xx"}`, "24h", ["service"])} / 86400`
    );
  });
  test("quantiles group by le", () => {
    expect(quantileQuery(Quantile.P99, "in", servicesScope(SHOWN), PerfRange.H6)).toBe(
      `histogram_quantile(0.99, ${wi(`backwork_hop_duration_seconds_bucket{dir="in"}`, "6h", ["service", "le"])})`
    );
    expect(quantileQuery(Quantile.P50, "out", connectionsScope(), PerfRange.H1)).toBe(
      `histogram_quantile(0.5, ${wi(`backwork_hop_duration_seconds_bucket{dir="out"}`, "1h", ["service", "peer", "via", "le"])})`
    );
  });
  test("time in data stores is store seconds over inbound seconds", () => {
    expect(storeShareQuery(servicesScope(SHOWN), PerfRange.H6)).toBe(
      `${wi(`backwork_hop_store_seconds_total`, "6h", ["service"])} / ${wi(`backwork_hop_duration_seconds_sum{dir="in"}`, "6h", ["service"])}`
    );
    expect(storeShareQuery(routesScope("svc", SHOWN), PerfRange.H6)).toBe(
      `${wi(`backwork_hop_store_seconds_total{service="svc"}`, "6h", ["service", "method", "op"])} / ${wi(`backwork_hop_duration_seconds_sum{dir="in",service="svc"}`, "6h", ["service", "method", "op"])}`
    );
  });
  test("data-store calls per request", () => {
    expect(storeCallsPerRequestQuery(servicesScope(SHOWN), PerfRange.H1)).toBe(
      `${wi(`backwork_hop_store_calls_total`, "1h", ["service"])} / ${wi(`backwork_hop_duration_seconds_count{dir="in"}`, "1h", ["service"])}`
    );
  });
  test("in progress is started minus finished over 15 minutes, clamped", () => {
    expect(inProgressQuery(SHOWN)).toBe(
      `clamp_min(${wi(`backwork_hop_started_total{dir="in"}`, "15m", ["service"])} - ${wi(`backwork_hop_duration_seconds_count{dir="in"}`, "15m", ["service"])}, 0) or ${wi(`backwork_hop_started_total{dir="in"}`, "15m", ["service"])}`
    );
  });
  test("trend uses twelve steps, never below a minute", () => {
    expect(trendStep(PerfRange.H1)).toBe("300s");
    expect(trendStep(PerfRange.H6)).toBe("1800s");
    expect(trendStep(PerfRange.D7)).toBe("50400s");
    expect(trendQuery(PerfRange.H1)).toContain("offset 300s");
  });
  test("a hostile service name stays inside its string", () => {
    const q = rateQuery("in", routesScope('x"}) or vector(1) #', SHOWN), PerfRange.H1);
    expect(q).toContain('service="x\\"}) or vector(1) #"');
  });
  test("Requests totals by status class, optionally for one service", () => {
    expect(httpTotalsQuery("1h", null, SHOWN)).toBe(
      `${wi(`backwork_hop_duration_seconds_count{dir="in",via="http"}`, "1h", ["status_class", "outcome"])}`
    );
    expect(httpP95Query("24h", "commerce-api", SHOWN)).toBe(
      `histogram_quantile(0.95, ${wi(`backwork_hop_duration_seconds_bucket{dir="in",via="http",service="commerce-api"}`, "24h", ["le"])})`
    );
  });
  test("health checks are left out of inbound figures by default", () => {
    const not = 'op!~"(?i)/(?:healthz|health|ready|live|livez|readyz|ping)"';
    expect(rateQuery("in", servicesScope(), PerfRange.H6)).toBe(
      `${wi(`backwork_hop_duration_seconds_count{dir="in",${not}}`, "6h", ["service"])} / 21600`
    );
    const [a, b] = errorRateQueries("in", servicesScope(), PerfRange.H1);
    expect(a).toContain(`outcome="error",${not}}`);
    expect(b).toContain(`status_class="5xx",${not}}`);
    expect(quantileQuery(Quantile.P95, "in", routesScope("svc"), PerfRange.H1)).toContain(`{dir="in",service="svc",${not}}`);
    expect(storeShareQuery(servicesScope(), PerfRange.H1)).toBe(
      `${wi(`backwork_hop_store_seconds_total{${not}}`, "1h", ["service"])} / ${wi(`backwork_hop_duration_seconds_sum{dir="in",${not}}`, "1h", ["service"])}`
    );
    expect(inProgressQuery()).toContain(`backwork_hop_started_total{dir="in",${not}}`);
    expect(httpTotalsQuery("1h", null)).toContain(`via="http",${not}}`);
    expect(trendQuery(PerfRange.H1)).toContain(not);
  });
  test("outbound connections never filter health checks", () => {
    expect(rateQuery("out", connectionsScope(), PerfRange.H1)).not.toContain("op!~");
    expect(rateQuery("out", servicesScope(), PerfRange.H1)).not.toContain("op!~");
  });
  test("shown health checks give the plain query", () => {
    expect(rateQuery("in", servicesScope(SHOWN), PerfRange.H1)).not.toContain("op!~");
  });
});

describe("combineFigures", () => {
  test("adds both error halves and keys by the scope labels", () => {
    const rows = combineFigures(["service"], {
      rate: [{ metric: { service: "a" }, value: 10 }, { metric: { service: "b" }, value: 2 }],
      errA: [{ metric: { service: "a" }, value: 0.1 }],
      errB: [{ metric: { service: "a" }, value: 0.2 }],
      p50: [{ metric: { service: "a" }, value: 0.038 }],
      p95: [{ metric: { service: "a" }, value: 0.212 }, { metric: { service: "b" }, value: NaN }],
      p99: [],
    });
    const a = rows.find((r) => r.metric.service === "a")!;
    expect(a.figures.rate).toBe(10);
    expect(a.figures.errorShare).toBeCloseTo(0.03, 10);
    expect(a.figures.p50).toBe(0.038);
    expect(a.figures.p99).toBeNull();
    const b = rows.find((r) => r.metric.service === "b")!;
    expect(b.figures.errorShare).toBe(0);
    expect(b.figures.p95).toBeNull();
  });
  test("drops rows with no traffic and caps the error share at 1", () => {
    const rows = combineFigures(["service"], {
      rate: [{ metric: { service: "a" }, value: 0 }, { metric: { service: "c" }, value: 1 }],
      errA: [{ metric: { service: "c" }, value: 5 }],
      errB: [],
      p50: [],
      p95: [],
      p99: [],
    });
    expect(rows.map((r) => r.metric.service)).toEqual(["c"]);
    expect(rows[0].figures.errorShare).toBe(1);
  });
});

describe("per second over a window", () => {
  test("window lengths", () => {
    expect(windowSeconds("15m")).toBe(900);
    expect(windowSeconds("6h")).toBe(21600);
    expect(windowSeconds("7d")).toBe(604800);
    expect(() => windowSeconds("6 hours")).toThrow();
  });
  test("requests per second is increase over the window divided by its length, never rate()", () => {
    for (const range of [PerfRange.H1, PerfRange.H6, PerfRange.H24, PerfRange.D7]) {
      const q = rateQuery("in", servicesScope(), range);
      expect(q).not.toContain("rate(");
      expect(q).toContain(`increase(`);
      expect(q.endsWith(` / ${windowSeconds(range)}`)).toBe(true);
    }
  });
});

describe("servicesTable", () => {
  test("joins every figure for each service, busiest first", async () => {
    const { client, seen } = fakeClient(
      [
        [/backwork_hop_started_total/, [{ metric: { service: "commerce-payments" }, value: 2.4 }]],
        [/store_seconds_total/, [{ metric: { service: "commerce-payments" }, value: 0.24 }]],
        [/store_calls_total/, [{ metric: { service: "commerce-payments" }, value: 3 }]],
        [/^clamp_min\(\(sum by \(service, via\)/, [
          { metric: { service: "commerce-payments", via: "http" }, value: 3.1 },
          { metric: { service: "commerce-worker", via: "job" }, value: 1.9 },
        ]],
        [/outcome="error"/, [{ metric: { service: "commerce-payments" }, value: 0.0372 }]],
        [/status_class="5xx"/, []],
        [/histogram_quantile\(0\.5,/, [{ metric: { service: "commerce-payments" }, value: 0.096 }]],
        [/histogram_quantile\(0\.95,/, [{ metric: { service: "commerce-payments" }, value: 0.64 }]],
        [/histogram_quantile\(0\.99,/, [{ metric: { service: "commerce-payments" }, value: 2.4 }]],
        [/^clamp_min\(\(sum by \(service\) \(increase\(backwork_hop_duration_seconds_count/, [
          { metric: { service: "commerce-payments" }, value: 3.1 },
          { metric: { service: "commerce-worker" }, value: 1.9 },
        ]],
      ],
      [[/histogram_quantile/, [{ metric: { service: "commerce-payments" }, points: [{ t: 1, v: 0.3 }, { t: 2, v: NaN }, { t: 3, v: 0.64 }] }]]]
    );
    const rows: ServiceRow[] = await servicesTable(PerfRange.H6, org(), client, 1_700_000_000_000);
    expect(rows.map((r) => r.service)).toEqual(["commerce-payments", "commerce-worker"]);
    const p = rows[0];
    expect(p.rate).toBe(3.1);
    expect(p.errorShare).toBeCloseTo(0.012, 10);
    expect(p.p50).toBe(0.096);
    expect(p.p95).toBe(0.64);
    expect(p.p99).toBe(2.4);
    expect(p.storeShare).toBe(0.24);
    expect(p.storeCallsPerRequest).toBe(3);
    expect(p.inProgress).toBe(2);
    expect(p.trend).toEqual([0.3, 0.64]);
    expect(p.mainVia).toBe("http");
    const w = rows[1];
    expect(w.storeShare).toBeNull();
    expect(w.inProgress).toBe(0);
    expect(w.mainVia).toBe("job");
    expect(seen.length).toBe(11);
  });

  test("is cached for 10 seconds per org and range", async () => {
    const { client, seen } = fakeClient([]);
    const t = org();
    await servicesTable(PerfRange.H1, t, client);
    const n = seen.length;
    await servicesTable(PerfRange.H1, t, client);
    expect(seen.length).toBe(n);
    await servicesTable(PerfRange.H24, t, client);
    expect(seen.length).toBe(2 * n);
    await servicesTable(PerfRange.H1, org(), client);
    expect(seen.length).toBe(3 * n);
  });

  test("an empty store gives an empty table", async () => {
    const { client } = fakeClient([]);
    expect(await servicesTable(PerfRange.H6, org(), client)).toEqual([]);
  });

  test("a failing backend rejects, and the rejection is not cached", async () => {
    const t = org();
    let calls = 0;
    const failing: PromClient = {
      async instant() { calls++; throw new Error("503 Service Unavailable"); },
      async range() { return []; },
    };
    await expect(servicesTable(PerfRange.H6, t, failing)).rejects.toThrow("503");
    const before = calls;
    await expect(servicesTable(PerfRange.H6, t, failing)).rejects.toThrow("503");
    expect(calls).toBeGreaterThan(before);
  });
});

describe("routesTable", () => {
  test("slowest p95 first, with the store share per route", async () => {
    const r = (method: string, op: string, value: number): Sample => ({ metric: { service: "commerce-payments", method, op }, value });
    const { client } = fakeClient([
      [/store_seconds_total/, [r("GET", "/charges/:id", 0.71)]],
      [/histogram_quantile\(0\.95,/, [r("POST", "/charges", 0.72), r("POST", "/transfers", 2.4), r("GET", "/charges/:id", 0.031)]],
      [/histogram_quantile/, []],
      [/outcome/, []],
      [/status_class/, []],
      [/count/, [r("POST", "/charges", 1.8), r("POST", "/transfers", 0.3), r("GET", "/charges/:id", 0.9)]],
    ]);
    const rows = await routesTable("commerce-payments", PerfRange.H6, org(), client);
    expect(rows.map((x) => x.op)).toEqual(["/transfers", "/charges", "/charges/:id"]);
    expect(rows[2].storeShare).toBe(0.71);
    expect(rows[0].storeShare).toBeNull();
  });
  test("a service name outside HOP-12 never reaches a query", async () => {
    const { client, seen } = fakeClient([]);
    expect(await routesTable("bad name", PerfRange.H6, org(), client)).toEqual([]);
    expect(await routesTable("", PerfRange.H6, org(), client)).toEqual([]);
    expect(seen).toEqual([]);
  });
});

describe("connections", () => {
  test("peer kinds", () => {
    const known = new Set(["commerce-risk"]);
    expect(peerKindOf("http", "commerce-risk", known)).toBe(PeerKind.Service);
    expect(peerKindOf("db", "payments-db", known)).toBe(PeerKind.Database);
    expect(peerKindOf("cache", "redis.internal", known)).toBe(PeerKind.Cache);
    expect(peerKindOf("http", "bank-gw.internal", known)).toBe(PeerKind.Unmatched);
    expect(peerKindOf(null, "x", known)).toBe(PeerKind.Unmatched);
  });
  test("rows touching the selected service come first", () => {
    const row = (service: string, peer: string, rate: number): ConnectionRow => ({
      service, peer, rate, via: "http", peerKind: PeerKind.Unmatched, errorShare: 0, p50: null, p95: null, p99: null,
    });
    const sorted = sortConnections([row("a", "b", 9), row("c", "d", 1), row("x", "c", 0.5), row("e", "f", 5)], "c");
    expect(sorted.map((r) => `${r.service}>${r.peer}`)).toEqual(["c>d", "x>c", "a>b", "e>f"]);
    expect(sortConnections([row("a", "b", 1), row("c", "d", 2)], null).map((r) => r.service)).toEqual(["c", "a"]);
  });
  test("connectionsTable maps via and peer", async () => {
    const m = (peer: string, via: string, value: number): Sample => ({ metric: { service: "commerce-payments", peer, via }, value });
    const { client } = fakeClient([
      [/histogram_quantile\(0\.95,/, [m("payments-db", "db", 0.003)]],
      [/histogram_quantile/, []],
      [/outcome/, []],
      [/status_class/, []],
      [/count/, [m("payments-db", "db", 5.4), m("commerce-risk", "http", 1)]],
    ]);
    const rows = await connectionsTable(PerfRange.H6, org(), new Set(["commerce-risk"]), null, client);
    expect(rows.map((r) => [r.peer, r.peerKind, r.p95])).toEqual([
      ["payments-db", PeerKind.Database, 0.003],
      ["commerce-risk", PeerKind.Service, null],
    ]);
  });
});

describe("defaultService", () => {
  const s = (service: string, errorShare: number, p95: number): ServiceRow => ({
    service, errorShare, p95, rate: 1, p50: null, p99: null, storeShare: null, storeCallsPerRequest: null, inProgress: 0, trend: [], mainVia: null,
  });
  test("highest error share, then slowest", () => {
    expect(defaultService([s("api", 0.004, 0.2), s("pay", 0.012, 0.6), s("worker", 0.003, 1.1)])).toBe("pay");
    expect(defaultService([s("a", 0, 0.2), s("b", 0, 0.9)])).toBe("b");
    expect(defaultService([])).toBeNull();
  });
});

describe("inboundHttpTotals", () => {
  test("sums classes and counts errors once", async () => {
    const { client } = fakeClient([
      [/histogram_quantile/, [{ metric: {}, value: 0.412 }]],
      [/increase/, [
        { metric: { status_class: "2xx", outcome: "ok" }, value: 1250.6 },
        { metric: { status_class: "2xx", outcome: "error" }, value: 1 },
        { metric: { status_class: "4xx", outcome: "ok" }, value: 17 },
        { metric: { status_class: "5xx", outcome: "error" }, value: 12 },
        { metric: { status_class: "3xx", outcome: "ok" }, value: 4 },
      ]],
    ]);
    const t = await inboundHttpTotals("1h", null, org(), client);
    expect(t.total).toBe(1285);
    expect(t.byClass).toEqual({ "2xx": 1252, "3xx": 4, "4xx": 17, "5xx": 12 });
    expect(t.errorShare).toBeCloseTo(13 / 1285, 10);
    expect(t.p95).toBe(0.412);
  });
});

describe("inboundServices", () => {
  test("lists valid service names once, sorted", async () => {
    const { client, seen } = fakeClient([[/last_over_time/, [
      { metric: { service: "b" }, value: 1 },
      { metric: { service: "a" }, value: 2 },
      { metric: { service: "bad name" }, value: 1 },
      { metric: {}, value: 1 },
    ]]]);
    expect(await inboundServices(org(), client)).toEqual(["a", "b"]);
    expect(seen).toEqual(['count by (service) (last_over_time(backwork_hop_started_total{dir="in"}[14d]))']);
  });
});
