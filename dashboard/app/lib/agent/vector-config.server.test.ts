import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { FEATURES, type Feature } from "~/lib/controls.server";
import {
  COLLECTOR_METRICS,
  HOP_BUCKETS,
  RECORDS_INTAKE,
  RECORDS_METRICS,
  agentConfigYaml,
  controlsVrl,
  defaultSnapshot,
  inlineVrl,
  metricTransformsYaml,
  recordsSnapshot,
  stackConfigYaml,
  vrlRegex,
} from "./vector-config.server";

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
  test("BAC-79: the Database and cache switch strips the new totals, as the ingest proxy does", () => {
    const snap = defaultSnapshot();
    snap.project = { ...snap.project, stores: false };
    const v = controlsVrl(snap);
    expect(v).toContain(`includes(["db_n", "db_us", "db_wait_us", "cache_n", "cache_us", "cache_hit_n", "cache_miss_n"], k)`);
    expect(v).toContain(`replace(bw_head, r' (?:db|cache)_(?:n|us|hit_n|miss_n|wait_us)=\\S*', "")`);
    expect(v).toContain("bw_on_stores = false");
  });
  test("BAC-79: hits, misses and wait are their own counters, routed only when reported", () => {
    for (const y of [stackConfigYaml(), agentConfigYaml()]) {
      expect(y).toContain(`cache_hits: '.bw_m.stores == true && exists(.bw_m.cache_hit_n)'`);
      expect(y).toContain("inputs: [bw_hop_duration, bw_hop_started, bw_hop_store, bw_hop_store_cache_hit, bw_hop_store_cache_miss, bw_hop_store_db_wait]");
      expect(y).toContain("store: cache_hit");
      expect(y).toContain("store: cache_miss");
      expect(y).toContain("store: db_wait");
    }
    // The existing store transform keeps exactly its four counters.
    const store = stackConfigYaml().split("  bw_hop_store:\n")[1].split("\n\n")[0];
    expect(store.match(/- type: counter/g)?.length).toBe(4);
  });
});

describe("records intake (BAC-96)", () => {
  test("the stack collector has the records input and pipeline; the agent does not", () => {
    const y = stackConfigYaml();
    expect(y).toContain(`type: http_server\n    address: 0.0.0.0:${RECORDS_INTAKE.port}\n    path: ${RECORDS_INTAKE.path}`);
    for (const t of ["bw_rec_normalize", "bw_rec_detect", "bw_rec_controls", "bw_rec_tenant", "bw_rec_metric_prep", "bw_rec_hop_cardinality", "loki_records"]) expect(y).toContain(`  ${t}:\n`);
    expect(y).toContain("inputs: [vector_metrics, bw_hop_cardinality, bw_rec_hop_cardinality]");
    expect(y).toContain('org_id: "{{ org_id }}"');
    expect(agentConfigYaml()).not.toContain("bw_rec_");
  });
  test("the records copy of the metrics adds tenant labels and nothing else", () => {
    const own = metricTransformsYaml(COLLECTOR_METRICS);
    const rec = metricTransformsYaml(RECORDS_METRICS);
    expect(own).not.toContain("org_id");
    const normalise = (s: string): string =>
      s.replaceAll("bw_rec_", "bw_").replace(/\n {10}org_id: "\{\{ bw_m\.org_id \}\}"\n {10}project: "\{\{ bw_m\.project \}\}"/g, "").replace(/ *# Tenant labels[^\n]*\n[^\n]*\n[^\n]*\n/, "").replace(/value_limit: \d+/, "");
    expect(normalise(rec).replace("inputs: [bw_tenant]", "inputs: [bw_controls]")).toBe(normalise(own));
  });
  test("the records controls program enforces nothing the intake already did and runs no filter", () => {
    const v = controlsVrl(recordsSnapshot());
    expect(v).not.toContain("BWPROTECT");
    expect(v).not.toContain("Excluded paths");
    expect(v).not.toMatch(/= false\n/);
  });
});
