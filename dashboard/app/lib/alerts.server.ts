import { promises as fs } from "node:fs";
import path from "node:path";
import { config } from "./config.server";
import * as vm from "./vm.server";
import * as loki from "./loki.server";

export type AlertMetric = "cpu" | "memory_mb" | "restarts" | "error_rate" | "log_rate";

export type AlertRule = {
  id: string;
  name: string;
  metric: AlertMetric;
  service: string; // "*" = any service
  comparator: ">" | "<";
  threshold: number;
  channelIds: string[]; // notification channels to fire
  enabled: boolean;
};

export type AlertState = AlertRule & { firing: boolean; value: number };

export const METRIC_META: Record<AlertMetric, { label: string; hint: string; unit: string; source: "vm" | "loki" }> = {
  cpu: { label: "CPU usage (cores)", hint: "container CPU, in cores", unit: " cores", source: "vm" },
  memory_mb: { label: "Memory, busiest container (MB)", hint: "peak container working set", unit: " MB", source: "vm" },
  restarts: { label: "Restarts in last hour (count)", hint: "container restarts over 1h", unit: "", source: "vm" },
  error_rate: { label: "Error log rate (lines/sec)", hint: "error-level log lines per second", unit: "/s", source: "loki" },
  log_rate: { label: "Log volume (lines/sec)", hint: "all log lines per second", unit: "/s", source: "loki" },
};

const KEY = "container_label_coolify_resourceName";
const FILE = () => path.join(config.dataDir, "alerts.json");

const DEFAULTS: AlertRule[] = [
  { id: "r1", name: "High error rate (any service)", metric: "error_rate", service: "*", comparator: ">", threshold: 2, channelIds: [], enabled: true },
  { id: "r2", name: "Restart loop (any service)", metric: "restarts", service: "*", comparator: ">", threshold: 3, channelIds: [], enabled: true },
  { id: "r3", name: "High memory (any container)", metric: "memory_mb", service: "*", comparator: ">", threshold: 1024, channelIds: [], enabled: true },
];

export async function loadRules(): Promise<AlertRule[]> {
  try {
    const parsed = JSON.parse(await fs.readFile(FILE(), "utf8"));
    return Array.isArray(parsed) && parsed.length ? parsed : DEFAULTS;
  } catch {
    return DEFAULTS;
  }
}

export async function saveRules(rules: AlertRule[]): Promise<void> {
  try {
    await fs.mkdir(config.dataDir, { recursive: true });
    await fs.writeFile(FILE(), JSON.stringify(rules, null, 2), "utf8");
  } catch {
    /* data dir may be read-only; rules fall back to defaults */
  }
}

function svcSel(service: string, extra = ""): string {
  if (service === "*") return extra ? `{${extra}}` : "";
  const e = extra ? `${extra},` : "";
  return `{${e}${KEY}="${service}"}`;
}
function lokiSel(service: string, extra = ""): string {
  const parts = [extra, service === "*" ? `service=~".+"` : `service="${service}"`].filter(Boolean);
  return `{${parts.join(",")}}`;
}

async function evalRule(rule: AlertRule): Promise<number> {
  switch (rule.metric) {
    case "cpu":
      return vm.scalar(`sum(rate(container_cpu_usage_seconds_total${svcSel(rule.service, 'name!=""')}[5m]))`, 0);
    case "memory_mb":
      return vm.scalar(`max(container_memory_working_set_bytes${svcSel(rule.service, 'name!=""')})/1024/1024`, 0);
    case "restarts":
      return vm.scalar(`max(changes(container_start_time_seconds${svcSel(rule.service, 'name!=""')}[1h]))`, 0);
    case "error_rate":
      return loki.scalar(`sum(rate(${lokiSel(rule.service, 'level="error"')}[5m]))`, 0);
    case "log_rate":
      return loki.scalar(`sum(rate(${lokiSel(rule.service)}[5m]))`, 0);
  }
}

export async function evaluate(): Promise<AlertState[]> {
  const rules = await loadRules();
  const out = await Promise.all(
    rules.map(async (rule) => {
      let value = 0;
      try {
        value = await evalRule(rule);
      } catch {
        value = 0;
      }
      if (!Number.isFinite(value)) value = 0;
      const firing = rule.enabled && (rule.comparator === ">" ? value > rule.threshold : value < rule.threshold);
      return { ...rule, value, firing };
    })
  );
  return out;
}
