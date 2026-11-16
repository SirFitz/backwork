import { describe, expect, test } from "bun:test";
import {
  DEFAULT_REQUEST_FILTERS,
  SortDir,
  SortKey,
  StatusFilter,
  onlyClientFiltersChanged,
  parseRequestFilters,
  resultSetKey,
  serialiseRequestFilters,
  withRequestFilters,
  type RequestFilters,
} from "./request-filters";
import { HealthChecks } from "./hops/health";

const full: RequestFilters = {
  service: "commerce-api",
  range: "6h",
  health: HealthChecks.Shown,
  env: "production",
  q: "/orders",
  route: null,
  status: StatusFilter.S5xx,
  method: "POST",
  sort: { key: SortKey.Latency, dir: SortDir.Asc },
  chatty: true,
};

describe("Requests filters in the URL (BAC-90)", () => {
  test("defaults parse from an empty URL and serialise to nothing", () => {
    expect(parseRequestFilters(new URLSearchParams())).toEqual(DEFAULT_REQUEST_FILTERS);
    expect(serialiseRequestFilters(DEFAULT_REQUEST_FILTERS).toString()).toBe("");
  });

  test("every filter round-trips", () => {
    const p = serialiseRequestFilters(full);
    expect(p.toString()).toBe("env=production&service=commerce-api&range=6h&health=1&q=%2Forders&status=5xx&method=POST&sort=latency&dir=asc&chatty=1");
    expect(parseRequestFilters(p)).toEqual(full);
    // each filter on its own, too
    const singles: Partial<RequestFilters>[] = [
      { service: "a" }, { range: "24h" }, { health: HealthChecks.Shown }, { env: "dev" }, { q: "x y" }, { route: "/r/:id" },
      { status: StatusFilter.S4xx }, { method: "GET" }, { sort: { key: SortKey.Calls, dir: SortDir.Desc } }, { sort: { key: SortKey.Time, dir: SortDir.Asc } }, { chatty: true },
    ];
    for (const one of singles) {
      const f = { ...DEFAULT_REQUEST_FILTERS, ...one };
      expect(parseRequestFilters(serialiseRequestFilters(f))).toEqual(f);
    }
  });

  test("an exact route wins over the search text", () => {
    const f = { ...full, route: "/orders/:id" };
    const p = serialiseRequestFilters(f);
    expect(p.get("route")).toBe("/orders/:id");
    expect(p.has("q")).toBe(false);
  });

  test("bad values fall back to defaults", () => {
    const f = parseRequestFilters(new URLSearchParams("range=7d&status=6xx&method=G%20T&sort=size&dir=asc&env=BAD!&health=yes&chatty=true"));
    expect(f).toEqual(DEFAULT_REQUEST_FILTERS);
  });

  test("changing one filter keeps every other one", () => {
    const start = serialiseRequestFilters(full);
    start.set("pinned", "0"); // a parameter the filters do not own passes through
    start.set("before", "12345"); // the paging cursor goes
    const patches: Partial<RequestFilters>[] = [
      { service: "other" }, { range: "1h" }, { health: HealthChecks.Hidden }, { status: StatusFilter.All }, { method: "GET" },
      { q: "new text", route: null }, { sort: { key: null, dir: SortDir.Desc } }, { chatty: false }, { env: "dev" },
    ];
    for (const patch of patches) {
      const next = withRequestFilters(start, patch);
      expect(parseRequestFilters(next)).toEqual({ ...full, ...patch });
      expect(next.get("pinned")).toBe("0");
      expect(next.has("before")).toBe(false);
    }
  });

  test("changing service, then range, then search keeps the earlier choices", () => {
    let p = new URLSearchParams("env=dev");
    p = withRequestFilters(p, { service: "commerce-api" });
    p = withRequestFilters(p, { q: "orders" });
    p = withRequestFilters(p, { status: StatusFilter.S2xx });
    p = withRequestFilters(p, { method: "GET" });
    p = withRequestFilters(p, { range: "24h" });
    p = withRequestFilters(p, { service: "commerce-worker" });
    expect(parseRequestFilters(p)).toEqual({ ...DEFAULT_REQUEST_FILTERS, env: "dev", service: "commerce-worker", q: "orders", status: StatusFilter.S2xx, method: "GET", range: "24h" });
  });

  test("only the row filters changing needs no reload; service, range, health or env do", () => {
    const a = serialiseRequestFilters(full);
    for (const patch of [{ q: "x" }, { status: StatusFilter.All }, { method: "GET" }, { chatty: false }, { sort: { key: SortKey.Time, dir: SortDir.Desc } }, { route: "/x" }] as Partial<RequestFilters>[]) {
      expect(onlyClientFiltersChanged(a, withRequestFilters(a, patch))).toBe(true);
    }
    for (const patch of [{ service: "x" }, { range: "1h" }, { health: HealthChecks.Hidden }, { env: "dev" }] as Partial<RequestFilters>[]) {
      expect(onlyClientFiltersChanged(a, withRequestFilters(a, patch))).toBe(false);
    }
    expect(onlyClientFiltersChanged(a, new URLSearchParams(a))).toBe(false); // nothing changed: a poll, reload as usual
  });

  test("the result-set key follows what is loaded only", () => {
    expect(resultSetKey(full)).toBe(resultSetKey({ ...full, q: "other", status: StatusFilter.All }));
    expect(resultSetKey(full)).not.toBe(resultSetKey({ ...full, env: "dev" }));
    expect(resultSetKey(full)).not.toBe(resultSetKey({ ...full, range: "1h" }));
  });
});
