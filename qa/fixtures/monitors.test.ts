// BAC-80: the monitors scenario's lines, in every fixture format, read back by the dashboard's
// parser and rule. Run: cd qa/fixtures && bun test
import { describe, expect, test } from "bun:test";
import { Format, MONITOR_HOST, SHOPPER_HOST, monitorsCycle, render, scenariosOf, type Emission } from "./emitter";
import { parseHopRecord } from "../../dashboard/app/lib/hops/parse";
import { isHealthOrMonitor } from "../../dashboard/app/lib/hops/health";

const NOW = new Date(1_700_000_000_000);
const hops = (list: Emission[]): Extract<Emission, { kind: "hop" }>[] => list.filter((e): e is Extract<Emission, { kind: "hop" }> => e.kind === "hop");

describe("monitors scenario", () => {
  const cycle = monitorsCycle(1_700_000_000_000);
  for (const format of Object.values(Format)) {
    test(`every inbound hop of the monitor's trace is synthetic, none of the shopper's (${format})`, () => {
      const parsed = hops(cycle).map((e) => parseHopRecord({ ts: NOW.getTime(), line: render(e, format, NOW), labels: {} }));
      expect(parsed.every((r) => r !== null)).toBe(true);
      const inbound = parsed.filter((r) => r !== null && r.hop.startsWith("in"));
      const traces = new Set(inbound.map((r) => r?.traceId));
      expect(traces.size).toBe(2);
      const monitor = inbound.filter((r) => r?.synthetic);
      const shopper = inbound.filter((r) => !r?.synthetic);
      expect(monitor.length).toBe(10);
      expect(shopper.length).toBe(10);
      expect(new Set(monitor.map((r) => r?.traceId)).size).toBe(1);
      expect(monitor.every((r) => r !== null && isHealthOrMonitor(r))).toBe(true);
      expect(shopper.some((r) => r !== null && isHealthOrMonitor(r))).toBe(false);
      expect(monitor.find((r) => r?.service === "shop-api")?.host).toBe(MONITOR_HOST);
      expect(shopper.find((r) => r?.service === "shop-api")?.host).toBe(SHOPPER_HOST);
      expect(parsed.filter((r) => r !== null && r.hop.startsWith("out")).every((r) => r?.host === null && r?.synthetic === false)).toBe(true);
    });
  }
  test("SCENARIO is a comma list", () => {
    expect(scenariosOf("insights,monitors")).toEqual(["insights", "monitors"]);
    expect(scenariosOf("")).toEqual([]);
    expect(() => scenariosOf("insights,nope")).toThrow();
  });
});
