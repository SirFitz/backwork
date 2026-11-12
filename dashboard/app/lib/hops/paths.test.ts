import { describe, expect, test } from "bun:test";
import { pathTitle, requestPath, routeHint } from "./paths";

describe("requestPath / routeHint (BAC-52)", () => {
  test("the actual path, with the template as the hint", () => {
    const r = { path: "/api/v1/public/m/island-coffee/products", op: "/api/v1/public/m/:merchant_username/products" };
    expect(requestPath(r)).toBe(r.path);
    expect(routeHint(r)).toBe(r.op);
  });
  test("no path: the template, no hint; same text: no hint", () => {
    expect(requestPath({ path: null, op: "/orders" })).toBe("/orders");
    expect(routeHint({ path: null, op: "/orders" })).toBeNull();
    expect(routeHint({ path: "/orders", op: "/orders" })).toBeNull();
  });
});

describe("pathTitle (BAC-41: long and odd paths)", () => {
  test("a scanner path with no template: the path alone", () => {
    expect(pathTitle("/.env", null)).toBe("/.env");
    expect(pathTitle("/app/.env", "")).toBe("/app/.env");
  });
  test("path and a different template: both, template on its own line", () => {
    expect(pathTitle("/debug/vars", "/*")).toBe("/debug/vars\nroute /*");
  });
  test("the longest path HOP-24 allows (200 bytes) is kept whole", () => {
    const long = "/" + "a".repeat(199);
    expect(pathTitle(long, long)).toBe(long);
  });
  test("no path: the template; nothing: undefined", () => {
    expect(pathTitle(null, "/orders")).toBe("/orders");
    expect(pathTitle(null, null)).toBeUndefined();
    expect(pathTitle(null, "")).toBeUndefined();
  });
});
