import { describe, expect, test } from "bun:test";
import { MAX_DEPLOYS_PER_CALL, markerDetail, markerLabel, parseDeployPayload } from "./deploys";

const NOW = Date.UTC(2026, 10, 14, 12, 0, 0);

describe("parseDeployPayload", () => {
  test("one object, defaults at to now, trims, nulls absent fields", () => {
    const r = parseDeployPayload({ service: " shop-api ", version: "v1.4.2", extra: 1 }, NOW);
    expect(r).toEqual({ ok: true, deploys: [{ service: "shop-api", version: "v1.4.2", commit: null, environment: null, url: null, actor: null, atMs: NOW }] });
  });
  test("a list under deploys, up to 20", () => {
    const list = Array.from({ length: MAX_DEPLOYS_PER_CALL }, (_, i) => ({ service: "a", commit: `c${i}` }));
    const r = parseDeployPayload({ deploys: list }, NOW);
    expect(r.ok && r.deploys.length).toBe(20);
    const over = parseDeployPayload({ deploys: [...list, { service: "a" }] }, NOW);
    expect(over).toEqual({ ok: false, error: "deploys: at most 20 per call, got 21" });
  });
  test("bad shapes and fields", () => {
    expect(parseDeployPayload(null, NOW).ok).toBe(false);
    expect(parseDeployPayload([{ service: "a" }], NOW).ok).toBe(false);
    expect(parseDeployPayload("x", NOW).ok).toBe(false);
    expect(parseDeployPayload({ deploys: [] }, NOW)).toEqual({ ok: false, error: "deploys: empty list" });
    expect(parseDeployPayload({ deploys: "a" }, NOW).ok).toBe(false);
    expect(parseDeployPayload({}, NOW)).toMatchObject({ ok: false, error: expect.stringContaining("deploys[0].service") });
    expect(parseDeployPayload({ service: "has space" }, NOW).ok).toBe(false);
    expect(parseDeployPayload({ service: "a", version: 3 }, NOW)).toMatchObject({ ok: false, error: "deploys[0].version: expected a string" });
    expect(parseDeployPayload({ service: "a", actor: "x\ny" }, NOW).ok).toBe(false);
    expect(parseDeployPayload({ service: "a", url: "javascript:alert(1)" }, NOW).ok).toBe(false);
    expect(parseDeployPayload({ service: "a", url: "https://ci.example.com/run/1" }, NOW).ok).toBe(true);
    expect(parseDeployPayload({ deploys: [{ service: "a" }, { service: "" }] }, NOW)).toMatchObject({ ok: false, error: expect.stringContaining("deploys[1]") });
  });
  test("at: ISO time, at most 5 minutes ahead", () => {
    const past = parseDeployPayload({ service: "a", at: "2026-11-14T11:00:00Z" }, NOW);
    expect(past.ok && past.deploys[0].atMs).toBe(NOW - 3600_000);
    expect(parseDeployPayload({ service: "a", at: new Date(NOW + 5 * 60_000).toISOString() }, NOW).ok).toBe(true);
    expect(parseDeployPayload({ service: "a", at: new Date(NOW + 5 * 60_000 + 1000).toISOString() }, NOW)).toMatchObject({ ok: false, error: "deploys[0].at: more than 5 minutes in the future" });
    expect(parseDeployPayload({ service: "a", at: "yesterday" }, NOW).ok).toBe(false);
    expect(parseDeployPayload({ service: "a", at: 1 }, NOW).ok).toBe(false);
  });
});

describe("marker label", () => {
  test("version, else the first 7 characters of the commit, else deploy", () => {
    expect(markerLabel({ version: "v1.4.2", commit: "0123456789abcdef" })).toBe("v1.4.2");
    expect(markerLabel({ version: null, commit: "0123456789abcdef" })).toBe("0123456");
    expect(markerLabel({ version: null, commit: null })).toBe("deploy");
  });
  test("detail names version, commit, actor and UTC time", () => {
    expect(markerDetail({ version: "v2", commit: "abcdef0123", actor: "ci", environment: "production", deployedAt: NOW })).toBe(
      "deploy v2, commit abcdef0, by ci, production, 2026-11-14 12:00 UTC",
    );
  });
});
