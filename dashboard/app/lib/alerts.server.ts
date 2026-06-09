import { promises as fs } from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { ulid } from "ulid";
import { db, ensureSchema } from "~/db/index.server";
import { alertRules, alertChannels, migrations } from "~/db/schema";
import { config } from "./config.server";
import * as vm from "./vm.server";
import * as loki from "./loki.server";
import { tenantOf, platformOrgId, type Tenant } from "./tenant.server";

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

export const DEFAULT_RULES: Omit<AlertRule, "id">[] = [
  { name: "High error rate (any service)", metric: "error_rate", service: "*", comparator: ">", threshold: 2, channelIds: [], enabled: true },
  { name: "Restart loop (any service)", metric: "restarts", service: "*", comparator: ">", threshold: 3, channelIds: [], enabled: true },
  { name: "High memory (any container)", metric: "memory_mb", service: "*", comparator: ">", threshold: 1024, channelIds: [], enabled: true },
];

export async function loadRules(orgId: string): Promise<AlertRule[]> {
  await ensureSchema();
  const rows = await db.select({ data: alertRules.data }).from(alertRules).where(eq(alertRules.orgId, orgId));
  return rows.map((r) => r.data as unknown as AlertRule);
}

export async function saveRules(orgId: string, rules: AlertRule[]): Promise<void> {
  await ensureSchema();
  await db.transaction(async (tx) => {
    await tx.delete(alertRules).where(eq(alertRules.orgId, orgId));
    if (rules.length) {
      await tx.insert(alertRules).values(rules.map((r) => ({ id: r.id, orgId, data: r as unknown as Record<string, unknown> })));
    }
  });
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

async function evalRule(rule: AlertRule, tenant: Tenant): Promise<number> {
  switch (rule.metric) {
    case "cpu":
      return vm.scalar(`sum(rate(container_cpu_usage_seconds_total${svcSel(rule.service, 'name!=""')}[5m]))`, 0, tenant);
    case "memory_mb":
      return vm.scalar(`max(container_memory_working_set_bytes${svcSel(rule.service, 'name!=""')})/1024/1024`, 0, tenant);
    case "restarts":
      return vm.scalar(`max(changes(container_start_time_seconds${svcSel(rule.service, 'name!=""')}[1h]))`, 0, tenant);
    case "error_rate":
      return loki.scalar(`sum(rate(${lokiSel(rule.service, 'level="error"')}[5m]))`, 0, tenant);
    case "log_rate":
      return loki.scalar(`sum(rate(${lokiSel(rule.service)}[5m]))`, 0, tenant);
  }
}

export async function evaluate(tenant: Tenant): Promise<AlertState[]> {
  const rules = await loadRules(tenant.orgId);
  const out = await Promise.all(
    rules.map(async (rule) => {
      let value = 0;
      try {
        value = await evalRule(rule, tenant);
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

/** Org ids that have at least one alert rule (for the background evaluator). */
export async function orgsWithRules(): Promise<string[]> {
  await ensureSchema();
  const rows = await db.selectDistinct({ orgId: alertRules.orgId }).from(alertRules);
  return rows.map((r) => r.orgId);
}

async function readJsonArray(file: string): Promise<any[]> {
  try {
    const parsed = JSON.parse(await fs.readFile(path.join(config.dataDir, file), "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** One-time: migrate the platform's legacy file-based rules/channels into the DB
 *  (falling back to defaults), so the existing setup isn't lost on cutover. */
export async function seedPlatformDefaults(): Promise<void> {
  try {
    await ensureSchema();
    const orgId = platformOrgId();
    if (!orgId) return;
    const done = await db.select({ name: migrations.name }).from(migrations).where(eq(migrations.name, "alerts_seed_v1")).limit(1);
    if (done.length) return;

    const haveRules = await db.select({ id: alertRules.id }).from(alertRules).where(eq(alertRules.orgId, orgId)).limit(1);
    if (!haveRules.length) {
      let rules: AlertRule[] = (await readJsonArray("alerts.json")) as AlertRule[];
      if (!rules.length) rules = DEFAULT_RULES.map((r) => ({ ...r, id: ulid() }));
      rules = rules.map((r) => (r.id ? r : { ...r, id: ulid() }));
      await db.insert(alertRules).values(rules.map((r) => ({ id: r.id, orgId, data: r as unknown as Record<string, unknown> })));
    }

    const haveCh = await db.select({ id: alertChannels.id }).from(alertChannels).where(eq(alertChannels.orgId, orgId)).limit(1);
    if (!haveCh.length) {
      const chans = await readJsonArray("channels.json");
      if (chans.length) {
        await db.insert(alertChannels).values(chans.filter((c) => c?.id).map((c) => ({ id: c.id, orgId, data: c as unknown as Record<string, unknown> })));
      }
    }

    await db.insert(migrations).values({ name: "alerts_seed_v1" }).onConflictDoNothing();
  } catch {
    /* org row may not exist yet, or read-only data dir; retry next boot */
  }
}

export { tenantOf };
