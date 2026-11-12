import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { FEATURES, type Feature } from "~/lib/controls.server";
import { HOP_BUCKETS, agentConfigYaml, controlsVrl, defaultSnapshot, inlineVrl, stackConfigYaml, vrlRegex } from "./vector-config.server";

describe("vector config", () => {
  test("infra/vector/vector.yaml is generated from this module (run bun infra/vector/generate.ts)", () => {
    const file = readFileSync(join(import.meta.dir, "../../../../infra/vector/vector.yaml"), "utf8");
    expect(file).toBe(stackConfigYaml());
  });
  test("design 5.3 buckets", () => {
    expect(HOP_BUCKETS).toEqual([0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 300, 900]);
    expect(agentConfigYaml()).toContain(`buckets: [${HOP_BUCKETS.join(", ")}]`);
  });
  test("agent ships hop metrics by remote write and has a PM2 file source", () => {
    const y = agentConfigYaml();
    expect(y).toContain("type: prometheus_remote_write");
    expect(y).toContain("/metrics/api/v1/write?kind=hop");
    expect(y).toContain('include: ["/pm2-logs/*.log"]');
    expect(y).toContain('kind: "{{ kind }}"');
  });
  test("every $ in inline VRL is doubled for Vector's env interpolation", () => {
    expect(inlineVrl('a = "$1"', 0)).toBe('a = "$$1"');
    expect(stackConfigYaml()).not.toMatch(/[^$]\$[^$]/);
  });
  test("regex literal escapes single quotes", () => {
    expect(vrlRegex("it's")).toBe("r'it\\x27s'");
  });
  test("controls: project values and per-service overrides", () => {
    const snap = defaultSnapshot();
    const off = Object.fromEntries(FEATURES.map((f) => [f, f !== "hops"])) as Record<Feature, boolean>;
    snap.services = { "commerce-api": off, "same": { ...snap.project } };
    const v = controlsVrl(snap);
    expect(v).toContain("bw_on_hops = true");
    expect(v).toContain('if bw_svc == "commerce-api" {\n  bw_on_hops = false\n}');
    expect(v).not.toContain('"same"');
  });
  test("no filter block when there are no patterns", () => {
    const snap = { ...defaultSnapshot(), patterns: [] };
    expect(controlsVrl(snap)).not.toContain("BWPROTECT");
  });
});
