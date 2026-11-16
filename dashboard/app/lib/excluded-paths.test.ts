import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  EXCLUDED_PATH_ERROR_TEXT,
  ExcludedPathError,
  MAX_EXCLUDED_PATH_LENGTH,
  compileExcludedPaths,
  lineExcluded,
  normalizeExcludedPath,
  pathExcluded,
  validateExcludedPath,
} from "./excluded-paths";
import { effectiveExcludedPaths, type ExcludedPathRow } from "./excluded-paths.server";
import { BUILT_IN_PATTERNS, compileFilter, snapshotVersion, type ControlsSnapshot } from "./controls.server";
import { controlsTransformYaml, controlsVrl, defaultSnapshot, excludedPathsVrl } from "./agent/vector-config.server";
import { buildControlsView, excludedPathViews } from "./controls-view.server";
import { enforceStreams, type LokiStream } from "./ingest/enforce.server";

describe("validateExcludedPath", () => {
  test("accepts exact paths and wildcards", () => {
    for (const p of ["/health", "/", "/socket.io/*", "/assets/*.js", "/v1/*/status", "/api/m/~user/%20x", "/a:b@c;d=e,f+g!h$i&j'k(l)"]) {
      expect(validateExcludedPath(p)).toBeNull();
    }
  });
  test("refuses what is not a path", () => {
    expect(validateExcludedPath("")).toBe(ExcludedPathError.Empty);
    expect(validateExcludedPath("health")).toBe(ExcludedPathError.NoSlash);
    expect(validateExcludedPath("*")).toBe(ExcludedPathError.NoSlash);
    expect(validateExcludedPath("/" + "a".repeat(MAX_EXCLUDED_PATH_LENGTH))).toBe(ExcludedPathError.TooLong);
    expect(validateExcludedPath("/" + "a".repeat(MAX_EXCLUDED_PATH_LENGTH - 1))).toBeNull();
    for (const p of ["/a b", "/health?x=1", "/a#b", "/a\"b", "/a\\b", "/a|b", "/a[b]", "/a{1}", "/a^b", "/é", "/a\tb"]) {
      expect(validateExcludedPath(p)).toBe(ExcludedPathError.BadCharacters);
    }
  });
  test("refuses a pattern that would drop every request", () => {
    for (const p of ["/*", "/**", "/*/*", "//*"]) expect(validateExcludedPath(p)).toBe(ExcludedPathError.MatchesEverything);
  });
  test("trims surrounding space; every error has text", () => {
    expect(normalizeExcludedPath("  /health \n")).toBe("/health");
    for (const e of Object.values(ExcludedPathError)) expect(EXCLUDED_PATH_ERROR_TEXT[e].length).toBeGreaterThan(0);
  });
});

describe("matching", () => {
  const m = compileExcludedPaths(["/health", "/socket.io/*", "/assets/*.js", "/v1/a.b+(c)", "/$x"]);
  test("exact path, query string and fragment ignored", () => {
    expect(pathExcluded(m, "/health")).toBe(true);
    expect(pathExcluded(m, "/health?probe=1")).toBe(true);
    expect(pathExcluded(m, "/health#x")).toBe(true);
    expect(pathExcluded(m, "/healthz")).toBe(false);
    expect(pathExcluded(m, "/api/health")).toBe(false);
    expect(pathExcluded(m, "/health/")).toBe(false);
  });
  test("wildcards match any run of characters, slashes included", () => {
    expect(pathExcluded(m, "/socket.io/")).toBe(true);
    expect(pathExcluded(m, "/socket.io/?EIO=4&transport=polling")).toBe(true);
    expect(pathExcluded(m, "/socket.io/a/b")).toBe(true);
    expect(pathExcluded(m, "/socket.io")).toBe(false);
    expect(pathExcluded(m, "/socketXio/a")).toBe(false);
    expect(pathExcluded(m, "/assets/app.4f2c.js")).toBe(true);
    expect(pathExcluded(m, "/assets/js/app.js")).toBe(true);
    expect(pathExcluded(m, "/assets/app.css")).toBe(false);
  });
  test("regex characters in a path are literal", () => {
    expect(pathExcluded(m, "/v1/a.b+(c)")).toBe(true);
    expect(pathExcluded(m, "/v1/aXbb(c)")).toBe(false);
    expect(pathExcluded(m, "/$x")).toBe(true);
  });
  test("no patterns, empty or missing path: nothing matches", () => {
    const none = compileExcludedPaths([]);
    expect(none.path).toBeNull();
    expect(pathExcluded(none, "/health")).toBe(false);
    expect(lineExcluded(none, "GET /health 200")).toBe(false);
    expect(pathExcluded(m, "")).toBe(false);
    expect(pathExcluded(m, null)).toBe(false);
  });
  test("ordinary lines that mention a matching path, standing on its own", () => {
    expect(lineExcluded(m, "GET /health 200 1.2ms")).toBe(true);
    expect(lineExcluded(m, "/health")).toBe(true);
    expect(lineExcluded(m, `10.0.0.4 - - "GET /health?probe=1 HTTP/1.1" 200`)).toBe(true);
    expect(lineExcluded(m, `{"msg":"done","url":"/socket.io/?EIO=4"}`)).toBe(true);
    expect(lineExcluded(m, "url=/assets/app.js status=200")).toBe(true);
    expect(lineExcluded(m, "GET /healthz 200")).toBe(false);
    expect(lineExcluded(m, "GET /api/health 200")).toBe(false);
    expect(lineExcluded(m, "GET /assets/app.js.map 200")).toBe(false);
    expect(lineExcluded(m, "server started")).toBe(false);
  });
});

const row = (pattern: string, projectId: string | null): ExcludedPathRow => ({
  id: pattern + (projectId ?? ""),
  orgId: "o",
  projectId,
  pattern,
  createdBy: null,
  createdAt: new Date(0),
});

describe("scopes", () => {
  const rows = [row("/b", "p1"), row("/health", null), row("/a", "p1"), row("/c", "p2"), row("/health", "p1")];
  test("a project gets the organisation's paths and its own, once each", () => {
    expect(effectiveExcludedPaths(rows, "p1")).toEqual(["/health", "/a", "/b"]);
    expect(effectiveExcludedPaths(rows, "p2")).toEqual(["/health", "/c"]);
    expect(effectiveExcludedPaths(rows, null)).toEqual(["/health"]);
  });
  test("Settings lists every entry with its scope; a project marks organisation entries inherited", () => {
    const projects = [{ id: "p1", name: "production" }, { id: "p2", name: "staging" }];
    const all = excludedPathViews(rows, null, projects);
    expect(all.map((v) => `${v.scopeLabel} ${v.pattern}`)).toEqual([
      "All projects /health",
      "production /a",
      "production /b",
      "production /health",
      "staging /c",
    ]);
    expect(all.every((v) => !v.inherited)).toBe(true);
    const one = excludedPathViews(rows, "p2", projects);
    expect(one.map((v) => [v.pattern, v.inherited])).toEqual([["/health", true], ["/c", false]]);
  });
  test("the panel carries the list, the cap and the scope choices on Settings only", () => {
    const base = { rows: [], patterns: BUILT_IN_PATTERNS, services: [], canManage: true, excludedPaths: rows, projects: [{ id: "p2", name: "staging" }, { id: "p1", name: "production" }] };
    const settings = buildControlsView({ ...base, projectId: null });
    expect(settings.pathProjects.map((p) => p.name)).toEqual(["production", "staging"]);
    expect(settings.maxExcludedPaths).toBe(100);
    expect(settings.excludedPaths).toHaveLength(5);
    const project = buildControlsView({ ...base, projectId: "p1" });
    expect(project.pathProjects).toEqual([]);
    expect(project.excludedPaths).toHaveLength(4);
  });
});

describe("controls snapshot and agent config (BAC-82)", () => {
  const content = (excludedPaths: string[]): Omit<ControlsSnapshot, "version"> => {
    const { version: _v, ...rest } = defaultSnapshot();
    return { ...rest, excludedPaths };
  };
  test("an empty list keeps the version agents already have; a change changes it", () => {
    const { project, services, patterns, serviceNames } = content([]);
    const before = createHash("sha256").update(JSON.stringify({ project, services, patterns, serviceNames })).digest("hex").slice(0, 16);
    expect(snapshotVersion(content([]))).toBe(before);
    expect(snapshotVersion(content(["/sinktest"]))).not.toBe(before);
    expect(snapshotVersion(content(["/sinktest"]))).not.toBe(snapshotVersion(content(["/sinktest", "/a"])));
  });
  test("no paths: the controls program is unchanged", () => {
    expect(excludedPathsVrl([])).toBe("");
    expect(controlsVrl(defaultSnapshot())).not.toContain("Excluded paths");
  });
  test("paths: hop records by path or op, and ordinary lines, are dropped before the switches", () => {
    const snap = { ...defaultSnapshot(), excludedPaths: ["/sinktest", "/socket.io/*"] };
    const v = controlsVrl(snap);
    expect(v).toContain(`match(bw_xp, r'^(?:/sinktest|/socket\\.io/.*)$')`);
    expect(v).toContain(`match(bw_xo, r'^(?:/sinktest|/socket\\.io/.*)$')`);
    expect(v).toContain(`if bw_kind == "log" && match(to_string(.message) ?? "", r'(?:^|[\\s"\\x27=(\\[])(?:/sinktest|/socket\\.io/[^\\s"\\x27?#,;)\\]]*)(?:$|[\\s"\\x27?#,;)\\]])') { abort }`);
    expect(v.indexOf("Excluded paths")).toBeLessThan(v.indexOf(`!bw_on_logs`));
    expect(v.indexOf("bw_h = object(%bw_hop)")).toBeLessThan(v.indexOf("Excluded paths"));
  });
  test("a $ in a path survives Vector's variable expansion", () => {
    const y = controlsTransformYaml({ ...defaultSnapshot(), excludedPaths: ["/$x"] });
    expect(y).toContain("/\\$$x");
  });
});

describe("ingest enforcement (BAC-82)", () => {
  const T = "8a1e3c5b9d2f4a6c8e0b1d3f5a7c9e10";
  const hop = (path: string, hopKind = "in"): string =>
    `trace_id=${T} hop=${hopKind} hop_id=1f0a6c2e9b7d4405 parent_id=b7ad6b7169203331 service=courier-portal-api via=http method=GET op=${path} path=${path}`;
  const env = (message: string): string => JSON.stringify({ message, display: message, service: "courier-portal-api" });
  const push = (lines: string[]): LokiStream[] => [{ stream: { service: "courier-portal-api" }, values: lines.map((l, i) => [String(1731390000000000000 + i), l]) }];
  const filter = compileFilter(BUILT_IN_PATTERNS);
  const excluded = compileExcludedPaths(["/sinktest", "/socket.io/*"]);
  test("matching hop records and ordinary lines are not saved; the rest is", () => {
    const r = enforceStreams(
      push([
        env(hop("/sinktest")),
        env(hop("/sinktest", "in_end") + " outcome=ok status=200 duration_us=900"),
        env(JSON.stringify({ trace_id: T, hop: "in", hop_id: "2f0a6c2e9b7d4405", via: "http", op: "/socket.io/", path: "/socket.io/?EIO=4" })),
        env("GET /sinktest 200"),
        env(hop("/sinktest-keep")),
        env("GET /sinktest-keep 200"),
        env(`trace_id=${T} link_name=order_id link_value=/sinktest hop_id=1f0a6c2e9b7d4405`),
      ]),
      { projectId: "p", rows: [], filter, excluded },
    );
    expect(r.dropped).toBe(4);
    expect(r.kept).toBe(3);
    expect(r.requests).toBe(1);
    const kept = r.streams.flatMap((s) => s.values.map((v) => (JSON.parse(v[1] as string) as { message: string }).message));
    expect(kept.some((m) => m.includes("path=/sinktest-keep"))).toBe(true);
    expect(kept.some((m) => /path=\/sinktest(?:\s|$)/.test(m))).toBe(false);
  });
  test("without a matcher nothing is dropped", () => {
    const r = enforceStreams(push([env(hop("/sinktest"))]), { projectId: "p", rows: [], filter });
    expect(r.kept).toBe(1);
  });
});
