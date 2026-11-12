import { describe, expect, test } from "bun:test";
import {
  BUILT_IN_PATTERNS,
  FILTERED,
  Feature,
  PatternError,
  applyFilter,
  compileFilter,
  resolveAll,
  resolveEffective,
  validatePattern,
  type ControlRow,
  type FilterPattern,
} from "./controls.server";

const row = (p: Partial<ControlRow> & Pick<ControlRow, "feature" | "enabled">): ControlRow => ({
  orgId: "o1",
  projectId: null,
  service: null,
  updatedBy: null,
  updatedAt: new Date(0),
  ...p,
});

describe("resolveEffective", () => {
  test("no rows: everything on", () => {
    const all = resolveAll([], "p1", "api");
    expect(Object.values(all).every(Boolean)).toBe(true);
  });
  test("org off wins over project and service on", () => {
    const rows = [
      row({ feature: Feature.Hops, enabled: false }),
      row({ feature: Feature.Hops, enabled: true, projectId: "p1" }),
      row({ feature: Feature.Hops, enabled: true, projectId: "p1", service: "api" }),
    ];
    expect(resolveEffective(rows, "p1", "api", Feature.Hops)).toBe(false);
  });
  test("project off only affects that project", () => {
    const rows = [row({ feature: Feature.Logs, enabled: false, projectId: "p1" })];
    expect(resolveEffective(rows, "p1", "api", Feature.Logs)).toBe(false);
    expect(resolveEffective(rows, "p2", "api", Feature.Logs)).toBe(true);
    expect(resolveEffective(rows, "p1", "api", Feature.Hops)).toBe(true);
  });
  test("service off: in its project, or every project when project is null", () => {
    const rows = [
      row({ feature: Feature.Metrics, enabled: false, projectId: "p1", service: "api" }),
      row({ feature: Feature.Stores, enabled: false, service: "worker" }),
    ];
    expect(resolveEffective(rows, "p1", "api", Feature.Metrics)).toBe(false);
    expect(resolveEffective(rows, "p2", "api", Feature.Metrics)).toBe(true);
    expect(resolveEffective(rows, "p1", "web", Feature.Metrics)).toBe(true);
    expect(resolveEffective(rows, "p9", "worker", Feature.Stores)).toBe(false);
  });
  test("service row does not switch off the project as a whole", () => {
    const rows = [row({ feature: Feature.Logs, enabled: false, projectId: "p1", service: "api" })];
    expect(resolveEffective(rows, "p1", null, Feature.Logs)).toBe(true);
  });
});

const builtIns = compileFilter(BUILT_IN_PATTERNS);

describe("applyFilter built-ins", () => {
  test("card numbers in several forms", () => {
    for (const card of ["4111111111111111", "4111 1111 1111 1111", "5500-0000-0000-0004", "378282246310005"]) {
      expect(applyFilter(`paid with ${card} ok`, builtIns)).toBe(`paid with ${FILTERED} ok`);
    }
  });
  test("emails", () => {
    expect(applyFilter('{"msg":"sent to jane.doe+x@example.co.uk"}', builtIns)).toBe(`{"msg":"sent to ${FILTERED}"}`);
  });
  test("phones", () => {
    expect(applyFilter("call +18765551234 now", builtIns)).toBe(`call ${FILTERED} now`);
    expect(applyFilter("call (876) 555-1234 now", builtIns)).toBe(`call ${FILTERED} now`);
    expect(applyFilter("call 876-555-1234 now", builtIns)).toBe(`call ${FILTERED} now`);
  });
  test("passwords keep the key", () => {
    expect(applyFilter("login password=hunter2 user=x", builtIns)).toBe(`login password=${FILTERED} user=x`);
    expect(applyFilter('{"password":"s3cr3t!","a":1}', builtIns)).toBe(`{"password":"${FILTERED}","a":1}`);
  });
  test("api keys and tokens", () => {
    expect(applyFilter("api_key=abcd1234efgh", builtIns)).toBe(`api_key=${FILTERED}`);
    expect(applyFilter("Authorization: Bearer abc.def.ghi123", builtIns)).toContain(FILTERED);
    expect(applyFilter("key sk_live_51Habcdefghijkl used", builtIns)).toBe(`key ${FILTERED} used`);
    expect(applyFilter("got eyJhbGciOi.eyJzdWIiOiIx.SflKxwRJSMeKKF2QT4", builtIns)).toBe(`got ${FILTERED}`);
  });
  test("ordinary lines unchanged", () => {
    const lines = [
      "GET /orders 200 12ms",
      '{"level":30,"time":1731390000123,"msg":"order created","amount":1500,"order_id":98765}',
      "hop=in_end hop_id=4111111111111111 trace_id=4bf92f3577b34da6a3ce929d0e0e4736 duration_us=48211 status=201",
    ];
    for (const l of lines) expect(applyFilter(l, builtIns)).toBe(l);
  });
  test("never alters protected ids, even all-digit ones that look like cards", () => {
    const l = '{"trace_id":"41111111111111114111111111111111","hop_id":"4111111111111111","parent_hop":"5500000000000004","email":"a@b.co"}';
    expect(applyFilter(l, builtIns)).toBe(
      `{"trace_id":"41111111111111114111111111111111","hop_id":"4111111111111111","parent_hop":"5500000000000004","email":"${FILTERED}"}`,
    );
  });
  test("custom pattern replaces whole match", () => {
    const own: FilterPattern = { name: "member", pattern: "MBR-\\d{6}", enabled: true, builtIn: false, replacement: "ignored" };
    const f = compileFilter([...BUILT_IN_PATTERNS, own]);
    expect(applyFilter("member MBR-123456 joined", f)).toBe(`member ${FILTERED} joined`);
  });
  test("disabled pattern is not applied", () => {
    const f = compileFilter(BUILT_IN_PATTERNS.map((p) => ({ ...p, enabled: p.name !== "email_addresses" })));
    expect(applyFilter("a@b.co", f)).toBe("a@b.co");
  });
});

describe("validatePattern", () => {
  test("accepts a plain pattern", () => expect(validatePattern("member", "MBR-\\d{6}")).toBeNull());
  test("rejects lookaround and backrefs", () => {
    expect(validatePattern("x", "(?=a)b")).toBe(PatternError.Unsupported);
    expect(validatePattern("x", "(?<!a)b")).toBe(PatternError.Unsupported);
    expect(validatePattern("x", "(a)\\1")).toBe(PatternError.Unsupported);
  });
  test("rejects invalid, empty-matching, long and badly named", () => {
    expect(validatePattern("x", "(")).toBe(PatternError.Invalid);
    expect(validatePattern("x", "a*")).toBe(PatternError.MatchesEmpty);
    expect(validatePattern("x", "a".repeat(501))).toBe(PatternError.TooLong);
    expect(validatePattern("bad/name", "a")).toBe(PatternError.BadName);
    expect(validatePattern("x", "")).toBe(PatternError.Empty);
  });
});
