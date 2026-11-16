import { describe, expect, test } from "bun:test";
import { ENV_COOKIE, ENV_COOKIE_MAX_ORGS, EnvSource, envCookieValue, isDataPath, parseEnvCookie, pickEnv, readCookie, withEnv, type EnvOption } from "./env";

const dev: EnvOption = { id: "p1", slug: "dev", name: "dev" };
const prod: EnvOption = { id: "p2", slug: "production", name: "production" };
const staging: EnvOption = { id: "p3", slug: "staging", name: "Staging" };

describe("pickEnv (BAC-89): URL > cookie > production > first", () => {
  test("the URL wins when it names a project of the org", () => {
    expect(pickEnv([dev, prod], "dev", "production")).toEqual({ option: dev, source: EnvSource.Url });
  });
  test("the remembered choice is next", () => {
    expect(pickEnv([dev, prod], null, "dev")).toEqual({ option: dev, source: EnvSource.Cookie });
  });
  test("then production when the org has it", () => {
    expect(pickEnv([dev, prod], null, null)).toEqual({ option: prod, source: EnvSource.Production });
  });
  test("else the first project", () => {
    expect(pickEnv([staging, dev], null, null)).toEqual({ option: staging, source: EnvSource.First });
  });
  test("unknown or malformed values fall through", () => {
    expect(pickEnv([dev, prod], "nope", "Bad Slug!")).toEqual({ option: prod, source: EnvSource.Production });
    expect(pickEnv([dev, prod], '"}{', "staging")).toEqual({ option: prod, source: EnvSource.Production });
  });
  test("no projects: organisation-wide", () => {
    expect(pickEnv([], "dev", "dev")).toEqual({ option: null, source: EnvSource.None });
  });
});

describe("the remembered environment cookie", () => {
  test("round trip, per organisation", () => {
    const v = envCookieValue({ orgA: "dev" }, "orgB", "production");
    expect(parseEnvCookie(v)).toEqual({ orgA: "dev", orgB: "production" });
    expect(parseEnvCookie(envCookieValue(parseEnvCookie(v), "orgA", "production"))).toEqual({ orgB: "production", orgA: "production" });
  });
  test("read from a Cookie header", () => {
    const header = `theme=dark; ${ENV_COOKIE}=${envCookieValue({}, "o", "dev")}; x=1`;
    expect(parseEnvCookie(readCookie(header, ENV_COOKIE))).toEqual({ o: "dev" });
    expect(readCookie("a=1", ENV_COOKIE)).toBeNull();
  });
  test("malformed values read as empty, bad slugs are dropped", () => {
    expect(parseEnvCookie("%%%")).toEqual({});
    expect(parseEnvCookie(encodeURIComponent("[1,2]"))).toEqual({});
    expect(parseEnvCookie(encodeURIComponent(JSON.stringify({ a: "dev", b: "NO WAY", c: 3 })))).toEqual({ a: "dev" });
  });
  test("keeps at most the newest organisations", () => {
    let mem: Record<string, string> = {};
    for (let i = 0; i < ENV_COOKIE_MAX_ORGS + 5; i++) mem = parseEnvCookie(envCookieValue(mem, `org${i}`, "dev"));
    expect(Object.keys(mem)).toHaveLength(ENV_COOKIE_MAX_ORGS);
    expect(mem[`org${ENV_COOKIE_MAX_ORGS + 4}`]).toBe("dev");
    expect(mem.org0).toBeUndefined();
  });
});

describe("withEnv: every internal link carries the environment", () => {
  test("adds it to paths and keeps the query and hash", () => {
    expect(withEnv("/requests", "dev")).toBe("/requests?env=dev");
    expect(withEnv("/requests?service=a&range=6h#top", "dev")).toBe("/requests?service=a&range=6h&env=dev#top");
    expect(withEnv("?q=x", "dev")).toBe("?q=x&env=dev");
  });
  test("an env already on the link wins", () => {
    expect(withEnv("/logs?env=production", "dev")).toBe("/logs?env=production");
  });
  test("external, protocol-relative and other links are untouched; no env, no change", () => {
    expect(withEnv("https://example.com/x", "dev")).toBe("https://example.com/x");
    expect(withEnv("//example.com/x", "dev")).toBe("//example.com/x");
    expect(withEnv("relative", "dev")).toBe("relative");
    expect(withEnv("/requests", null)).toBe("/requests");
  });
});

test("isDataPath: the pages the picker scopes", () => {
  for (const p of ["/", "/requests", "/requests/abc", "/logs", "/insights/map", "/errors/x", "/performance"]) expect(isDataPath(p)).toBe(true);
  for (const p of ["/settings", "/projects", "/alerts", "/billing", "/requestsx"]) expect(isDataPath(p)).toBe(false);
});
