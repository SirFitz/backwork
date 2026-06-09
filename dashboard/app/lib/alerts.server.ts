import { promises as fs } from "node:fs";
import path from "node:path";
import { config } from "./config.server";
import * as vm from "./vm.server";

export type AlertRule = {
  id: string;
  name: string;
  metric: "error_rate" | "p95_latency" | "request_rate" | "cpu";
  service: string; // "*" = any
  comparator: ">" | "<";
  threshold: number;
  channel: string;
  enabled: boolean;
};

export type AlertState = AlertRule & { firing: boolean; value: number };

const FILE = () => path.join(config.dataDir, "alerts.json");

const DEFAULTS: AlertRule[] = [
  { id: "r1", name: "High error rate", metric: "error_rate", service: "*", comparator: ">", threshold: 5, channel: "#alerts", enabled: true },
  { id: "r2", name: "p95 latency degraded", metric: "p95_latency", service: "*", comparator: ">", threshold: 750, channel: "#alerts", enabled: true },
  { id: "r3", name: "Traffic drop", metric: "request_rate", service: "api", comparator: "<", threshold: 0.2, channel: "#oncall", enabled: true },
];

export async function loadRules(): Promise<AlertRule[]> {
  try {
    const raw = await fs.readFile(FILE(), "utf8");
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.length) return parsed;
    return DEFAULTS;
  } catch {
    return DEFAULTS;
  }
}

export async function saveRules(rules: AlertRule[]): Promise<void> {
  try {
    await fs.mkdir(config.dataDir, { recursive: true });
    await fs.writeFile(FILE(), JSON.stringify(rules, null, 2), "utf8");
  } catch {
    // data dir may be read-only in some envs — non-fatal, rules fall back to defaults
  }
}

function promQLFor(rule: AlertRule): string {
  const sel = rule.service === "*" ? "" : `{service="${rule.service}"}`;
  const errSel = rule.service === "*" ? `{status=~"5.."}` : `{status=~"5..",service="${rule.service}"}`;
  switch (rule.metric) {
    case "error_rate":
      return `100 * sum(rate(http_requests_total${errSel}[5m])) / clamp_min(sum(rate(http_requests_total${sel}[5m])),0.001)`;
    case "p95_latency":
      return `1000 * histogram_quantile(0.95, sum by (le)(rate(http_request_duration_seconds_bucket${sel}[5m])))`;
    case "request_rate":
      return `sum(rate(http_requests_total${sel}[5m]))`;
    case "cpu":
      return `sum(rate(process_cpu_seconds_total${sel}[5m]))`;
  }
}

export async function evaluate(): Promise<AlertState[]> {
  const rules = await loadRules();
  const out: AlertState[] = [];
  for (const rule of rules) {
    let value = 0;
    try {
      value = await vm.scalar(promQLFor(rule), 0);
    } catch {
      value = 0;
    }
    const firing = rule.enabled && (rule.comparator === ">" ? value > rule.threshold : value < rule.threshold);
    out.push({ ...rule, value, firing });
  }
  return out;
}
