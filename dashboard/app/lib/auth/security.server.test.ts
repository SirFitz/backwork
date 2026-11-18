import { describe, expect, test } from "bun:test";
import { safeRedirect } from "./security.server";

describe("safeRedirect", () => {
  test("keeps ordinary same-site paths, queries and hashes", () => {
    expect(safeRedirect("/requests")).toBe("/requests");
    expect(safeRedirect("/requests?q=a%20b&x=1#top")).toBe("/requests?q=a%20b&x=1#top");
    expect(safeRedirect("/invite/abc")).toBe("/invite/abc");
    expect(safeRedirect("/")).toBe("/");
  });
  test("rejects anything that can leave the site", () => {
    for (const bad of ["//evil.com", "/\\evil.com", "/%09/evil.com", "/\t/evil.com", "/\n/evil.com", "/%0a/evil.com", "/%5Cevil.com", "/a\\b", "https://evil.com", "evil.com", "javascript:alert(1)", "/%2F/evil.com", "/%", "", "/\u0000x"]) {
      expect(safeRedirect(bad)).toBe("/");
    }
    expect(safeRedirect(null)).toBe("/");
    expect(safeRedirect(42)).toBe("/");
    expect(safeRedirect("//evil.com", "/home")).toBe("/home");
  });
});
