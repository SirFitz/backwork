import { describe, expect, test } from "bun:test";
import { EMPTY_NAMES, buildServiceNames, displayService, serviceList, serviceMatcher } from "./service-names";
import { PAIRS_QUERY, serviceNames } from "./service-names.server";

// As on the live site, 2026-11-12: commerce-api's hop records come from container
// dev-commerce-api-dserve, whose ordinary lines are labelled with the container name.
const names = buildServiceNames([
  { source: "dev-commerce-api-dserve", service: "commerce-api" },
  { source: "dev-commerce-api", service: "commerce-api" },
  { source: "fs-web-hono-bserve", service: "fs-hono" },
  { source: "shared-box", service: "a" },
  { source: "shared-box", service: "b" },
]);

describe("buildServiceNames", () => {
  test("source -> service, and a service's sources sorted", () => {
    expect(names.bySource.get("dev-commerce-api-dserve")).toBe("commerce-api");
    expect(names.sourcesOf.get("commerce-api")).toEqual(["dev-commerce-api", "dev-commerce-api-dserve"]);
  });
  test("a source naming two services is ambiguous and left out", () => {
    expect(names.bySource.has("shared-box")).toBe(false);
    expect(names.sourcesOf.has("a")).toBe(false);
  });
});

describe("serviceMatcher (the Logs filter)", () => {
  test("a service with known sources selects them: hop records and ordinary lines together", () => {
    expect(serviceMatcher("commerce-api", names)).toBe('source=~"dev-commerce-api|dev-commerce-api-dserve"');
  });
  test("regex characters in a source are escaped", () => {
    const n = buildServiceNames([{ source: "api.v2+x", service: "api" }]);
    expect(serviceMatcher("api", n)).toBe('source=~"api\\\\.v2\\\\+x"');
  });
  test("unknown service, or no map: the service label as before", () => {
    expect(serviceMatcher("worker", names)).toBe('service="worker"');
    expect(serviceMatcher("commerce-api", EMPTY_NAMES)).toBe('service="commerce-api"');
  });
});

describe("one name in lists and rows", () => {
  test("Logs service list: one entry per service", () => {
    expect(serviceList(["commerce-api", "dev-commerce-api-dserve", "fs-web-hono-bserve", "postgres"], names)).toEqual(["commerce-api", "fs-hono", "postgres"]);
  });
  test("a row shows the service's own name for any line of its sources", () => {
    expect(displayService({ service: "dev-commerce-api-dserve", source: "dev-commerce-api-dserve" }, names)).toBe("commerce-api");
    expect(displayService({ service: "commerce-api", source: "dev-commerce-api-dserve" }, names)).toBe("commerce-api");
    expect(displayService({ service: "postgres", source: "postgres" }, names)).toBe("postgres");
    expect(displayService({ service: "old-line" }, names)).toBe("old-line");
  });
});

describe("serviceNames (learned from hop records)", () => {
  test("reads (service, source) pairs of hop records", async () => {
    let asked = "";
    const n = await serviceNames({ orgId: "org-sn-1", platform: false }, async (q) => {
      asked = q;
      return [{ service: "commerce-api", source: "dev-commerce-api-dserve" }, { service: "x" }];
    });
    expect(asked).toBe(PAIRS_QUERY);
    expect(n.sourcesOf.get("commerce-api")).toEqual(["dev-commerce-api-dserve"]);
  });
  test("Loki down: the empty map (the service label, as before)", async () => {
    const n = await serviceNames({ orgId: "org-sn-2", platform: false }, async () => { throw new Error("503"); });
    expect(n).toBe(EMPTY_NAMES);
  });
});
