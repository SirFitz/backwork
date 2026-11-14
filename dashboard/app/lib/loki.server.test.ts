import { describe, expect, test } from "bun:test";
import { metricInstant, METRIC_INSTANT_TIMEOUT_MS } from "./loki.server";

type Call = { url: string; init?: RequestInit & { timeoutMs?: number; retries?: number } };

function fakeFetch(result: unknown, calls: Call[]) {
  return async <T>(url: string, init?: RequestInit & { timeoutMs?: number; retries?: number }): Promise<T> => {
    calls.push({ url, init });
    return { status: "success", data: { resultType: "matrix", result } } as T;
  };
}

describe("metricInstant", () => {
  test("one step over the window, scoped to the org, no retry, long timeout", async () => {
    const calls: Call[] = [];
    const window = { start: 1_800_000_000_000, end: 1_800_003_600_000 };
    await metricInstant('sum by (service) (count_over_time({kind="hop"}[1h]))', window, { orgId: "org-a", platform: false }, undefined, fakeFetch([], calls));
    expect(calls.length).toBe(1);
    const url = new URL(calls[0].url);
    expect(url.pathname).toBe("/loki/api/v1/query_range");
    expect(url.searchParams.get("query")).toBe('sum by (service) (count_over_time({org_id="org-a",kind="hop"}[1h]))');
    expect(url.searchParams.get("start")).toBe("1800000000");
    expect(url.searchParams.get("end")).toBe("1800003600");
    expect(url.searchParams.get("step")).toBe("3600");
    expect(calls[0].init?.retries).toBe(0);
    expect(calls[0].init?.timeoutMs).toBe(METRIC_INSTANT_TIMEOUT_MS);
  });

  test("takes the last point of each series and skips empty ones", async () => {
    const calls: Call[] = [];
    const rows = await metricInstant(
      "q",
      { start: 0, end: 60_000 },
      { orgId: "p", platform: true },
      5000,
      fakeFetch([
        { metric: { service: "a" }, values: [[0, "1"], [60, "4.5"]] },
        { metric: { service: "b" }, values: [] },
        { metric: { service: "c" }, values: [[60, "NaN"]] },
      ], calls),
    );
    expect(rows).toEqual([{ metric: { service: "a" }, value: 4.5 }]);
    expect(calls[0].init?.timeoutMs).toBe(5000);
    expect(new URL(calls[0].url).searchParams.get("query")).toBe("q");
  });
});
