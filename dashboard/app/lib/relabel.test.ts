// BAC-51 step 2: lines labelled right at rest, one switch row per service.
import { describe, expect, test } from "bun:test";
import { Feature, canonicalRows, compileFilter, BUILT_IN_PATTERNS, type ControlRow } from "./controls.server";
import { buildServiceNames, canonicalName, relabelMap } from "./service-names";
import { controlsVrl, defaultSnapshot, relabelVrl } from "./agent/vector-config.server";
import { enforceStreams, type LokiStream } from "./ingest/enforce.server";

const names = buildServiceNames([
  { source: "dev-commerce-api-dserve", service: "commerce-api" },
  { source: "commerce-payments", service: "commerce-payments" },
]);
const off = (feature: ControlRow["feature"], service: string | null): ControlRow => ({
  orgId: "o", projectId: "p", service, feature, enabled: false, updatedBy: null, updatedAt: new Date(0),
});

describe("names for the agents", () => {
  test("relabelMap holds only sources whose name differs", () => {
    expect(relabelMap(names)).toEqual({ "dev-commerce-api-dserve": "commerce-api" });
    expect(canonicalName("dev-commerce-api-dserve", names.bySource)).toBe("commerce-api");
    expect(canonicalName("postgres", names.bySource)).toBe("postgres");
  });
  test("relabelVrl: nothing for an empty map, one lookup for ordinary lines otherwise", () => {
    expect(relabelVrl({})).toEqual([]);
    const vrl = relabelVrl(relabelMap(names)).join("\n");
    expect(vrl).toContain('{"dev-commerce-api-dserve": "commerce-api"}');
    expect(vrl).toContain('== "log"');
  });
  test("the controls program relabels before the switches read .service", () => {
    const snap = { ...defaultSnapshot(), serviceNames: relabelMap(names) };
    const vrl = controlsVrl(snap);
    expect(vrl.indexOf("bw_own")).toBeGreaterThan(-1);
    expect(vrl.indexOf("bw_own")).toBeLessThan(vrl.indexOf("bw_kind = "));
  });
});

describe("switch rows", () => {
  test("a row written under a container name acts as its service's row; off wins", () => {
    const rows = canonicalRows([off(Feature.Logs, "dev-commerce-api-dserve"), off(Feature.Hops, "postgres")], names.bySource);
    expect(rows.map((r) => r.service)).toEqual(["commerce-api", "postgres"]);
  });
});

describe("ingest stores ordinary lines under the service's own name", () => {
  const filter = compileFilter(BUILT_IN_PATTERNS);
  const push = (labels: Record<string, string>, line: string): LokiStream[] => [{ stream: labels, values: [["1731390000000000000", JSON.stringify({ message: line })]] }];
  test("known source: service label becomes the service's name, source kept", () => {
    const r = enforceStreams(push({ service: "dev-commerce-api-dserve", source: "dev-commerce-api-dserve" }, "loading products"), { projectId: "p", rows: [], filter, serviceOf: names.bySource });
    expect(r.streams[0].stream).toMatchObject({ service: "commerce-api", source: "dev-commerce-api-dserve", kind: "log" });
  });
  test("a source with no hop records keeps its label", () => {
    const r = enforceStreams(push({ service: "postgres-box", source: "postgres-box" }, "checkpoint"), { projectId: "p", rows: [], filter, serviceOf: names.bySource });
    expect(r.streams[0].stream.service).toBe("postgres-box");
  });
  test("a switch on the service's name drops the container's ordinary lines; one under the container name too", () => {
    for (const svc of ["commerce-api", "dev-commerce-api-dserve"]) {
      const r = enforceStreams(push({ service: "dev-commerce-api-dserve", source: "dev-commerce-api-dserve" }, "loading products"), { projectId: "p", rows: [off(Feature.Logs, svc)], filter, serviceOf: names.bySource });
      expect(r.dropped).toBe(1);
    }
  });
  test("without a map nothing changes", () => {
    const r = enforceStreams(push({ service: "dev-commerce-api-dserve", source: "dev-commerce-api-dserve" }, "loading products"), { projectId: "p", rows: [], filter });
    expect(r.streams[0].stream.service).toBe("dev-commerce-api-dserve");
  });
});
