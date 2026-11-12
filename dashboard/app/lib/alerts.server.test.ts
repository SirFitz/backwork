import { describe, expect, test } from "bun:test";
import { AlertMetric, METRIC_META, RETIRED_METRICS, RETIRED_NOTE, isAlertMetric, normalizeRule, ruleQuery, type AlertRule } from "./alerts.server";

const base: AlertRule = { id: "r1", name: "x", metric: AlertMetric.ErrorRate, service: "*", comparator: ">", threshold: 2, channelIds: [], enabled: true };

describe("alert kinds", () => {
  test("only log-based kinds remain", () => {
    expect(Object.keys(METRIC_META).sort()).toEqual(["error_rate", "log_rate"]);
    for (const k of RETIRED_METRICS) expect(isAlertMetric(k)).toBe(false);
  });
  test("a stored container rule comes back disabled with the note", () => {
    for (const metric of RETIRED_METRICS) {
      const r = normalizeRule({ ...base, metric, enabled: true });
      expect(r.enabled).toBe(false);
      expect(r.retired).toBe(RETIRED_NOTE);
    }
  });
  test("a log rule is unchanged", () => {
    expect(normalizeRule(base)).toEqual(base);
  });
  test("rules count ordinary log lines, never hop records", () => {
    expect(ruleQuery(AlertMetric.ErrorRate, "*")).toBe('sum(rate({kind!="hop",level="error",service=~".+"}[5m]))');
    expect(ruleQuery(AlertMetric.LogRate, 'a"b')).toBe('sum(rate({kind!="hop",service="a\\"b"}[5m]))');
  });
});
