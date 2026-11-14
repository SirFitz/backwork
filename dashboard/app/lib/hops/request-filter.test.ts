import { describe, expect, test } from "bun:test";
import { matchesRequestText } from "./request-filter";

const row = { route: "/api/v1/public/m/:merchant_username/products", path: "/api/v1/public/m/binary/products", service: "commerce-api", host: "binary.fleeksite.com" };

describe("matchesRequestText", () => {
  test("matches route, path, domain and service, ignoring case and spaces around", () => {
    for (const t of [":merchant_username", "/m/binary/", "binary.fleeksite.com", " FLEEKSITE ", "commerce-api"]) expect(matchesRequestText(row, t)).toBe(true);
  });
  test("no match", () => {
    expect(matchesRequestText(row, "shop.example.com")).toBe(false);
  });
  test("old rows without a host still match on the rest and never on a domain", () => {
    const old = { route: "/orders", path: null, service: "commerce-api" };
    expect(matchesRequestText(old, "orders")).toBe(true);
    expect(matchesRequestText(old, "fleeksite")).toBe(false);
    expect(matchesRequestText({ ...old, host: null }, "fleeksite")).toBe(false);
  });
  test("empty text matches every row", () => {
    expect(matchesRequestText(row, "  ")).toBe(true);
  });
});
