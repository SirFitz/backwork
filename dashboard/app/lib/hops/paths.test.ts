import { describe, expect, test } from "bun:test";
import { requestPath, routeHint } from "./paths";

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
