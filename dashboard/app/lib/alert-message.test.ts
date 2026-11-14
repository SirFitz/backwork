import { describe, expect, test } from "bun:test";
import { AlertMetric, Comparator, type AlertRule } from "./alert-kinds";
import { AlertNotify } from "./alert-decision";
import { alertMessage, fmtAgo, fmtAlertMs, previewLine } from "./alert-message";
import type { Deploy } from "./deploys";
import type { QueryRow } from "./hops/slow-queries";

const NOW = Date.UTC(2026, 10, 14, 12, 0, 0);
const URL = "https://backwork.dev";
const route: AlertRule = {
  id: "r1", name: "checkout p95 over 500 ms", metric: AlertMetric.RouteP95, service: "checkout-api", comparator: Comparator.Above,
  threshold: 500, channelIds: [], enabled: true, route: { method: "GET", op: "/checkout" }, window: "15m",
};
const deploy: Deploy = { id: "d1", projectId: null, service: "checkout-api", version: "v1.4.2", commit: null, environment: null, url: null, actor: null, deployedAt: NOW - 22 * 60_000 };

describe("alertMessage", () => {
  test("route p95 firing names the route, the limit, the window, the requests and the last deploy", () => {
    const m = alertMessage(route, { value: 740, noData: false, requests: 1820 }, AlertNotify.Firing, deploy, NOW, URL);
    expect(m.title).toBe("FIRING: checkout p95 over 500 ms");
    expect(m.body).toBe("GET /checkout in checkout-api: p95 is 740 ms (limit 500 ms) over the last 15 minutes, 1,820 requests. Last deploy of checkout-api: 22 minutes ago (v1.4.2).");
    expect(m.link).toBe("https://backwork.dev/performance?service=checkout-api");
  });
  test("resolved says it is back under; an old deploy is not mentioned", () => {
    const m = alertMessage(route, { value: 210, noData: false, requests: 1600 }, AlertNotify.Resolved, { ...deploy, deployedAt: NOW - 25 * 3600_000 }, NOW, URL);
    expect(m.title).toBe("RESOLVED: checkout p95 over 500 ms");
    expect(m.body).toBe("GET /checkout in checkout-api: p95 is 210 ms (back under 500 ms) over the last 15 minutes, 1,600 requests.");
  });
  test("route error rate in percent", () => {
    const m = alertMessage({ ...route, metric: AlertMetric.RouteErrorRate, threshold: 5, window: "1h" }, { value: 7.25, noData: false, requests: 400 }, AlertNotify.Firing, null, NOW, URL);
    expect(m.body).toBe("GET /checkout in checkout-api: errors are 7.3 percent of requests (limit 5 percent) over the last hour, 400 requests.");
  });
  test("slow query names the shape and links to its row on the board", () => {
    const q: QueryRow = { shapeId: "abcd1234", shape: "select * from orders where id = ?", sample: "", service: "shop-api", peer: null, table: "orders", calls: 120, totalS: 30, p95S: 0.4, p95Approx: false, shareOfDb: 1 };
    const m = alertMessage({ ...route, metric: AlertMetric.SlowQuery, route: undefined, service: "*", shape: "any", threshold: 300 }, { value: 400, noData: false, query: q }, AlertNotify.Firing, null, NOW, URL);
    expect(m.body).toBe("select * from orders where id = ? in shop-api: p95 is 400 ms (limit 300 ms) over the last hour, 120 calls.");
    expect(m.link).toBe("https://backwork.dev/insights/queries?open=shop-api%3Aabcd1234");
  });
  test("log kinds keep their old wording, without the em dash", () => {
    const m = alertMessage({ ...route, metric: AlertMetric.ErrorRate, service: "*", route: undefined, threshold: 2 }, { value: 3.1, noData: false }, AlertNotify.Firing, null, NOW, URL);
    expect(m.body).toBe("any service: Error log rate (lines/sec) > 2/s (currently 3.10/s)");
    expect(m.link).toBeNull();
  });
  test("no message has an em dash", () => {
    for (const k of [AlertNotify.Firing, AlertNotify.Resolved]) {
      for (const metric of Object.values(AlertMetric)) {
        const m = alertMessage({ ...route, metric }, { value: 1, noData: false, requests: 1 }, k, deploy, NOW, URL);
        expect(m.title + m.body).not.toContain("—");
      }
    }
  });
});

describe("previewLine and formats", () => {
  test("Right now lines", () => {
    expect(previewLine(route, { value: 412, noData: false, requests: 1240 })).toBe("Right now: p95 is 412 ms (1,240 requests).");
    expect(previewLine(route, { value: 0, noData: true, requests: 4 })).toBe("Right now: not enough requests to judge (4 in the last 15 minutes).");
    expect(previewLine({ ...route, metric: AlertMetric.SlowQuery }, { value: 0, noData: true })).toBe("Right now: no query with enough calls in the last hour.");
  });
  test("ms and ago", () => {
    expect(fmtAlertMs(2.44)).toBe("2.4 ms");
    expect(fmtAlertMs(1250.4)).toBe("1,250 ms");
    expect(fmtAgo(30_000)).toBe("just now");
    expect(fmtAgo(60_000)).toBe("1 minute ago");
    expect(fmtAgo(3 * 3600_000)).toBe("3 hours ago");
  });
});
