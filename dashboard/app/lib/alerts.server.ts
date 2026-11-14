import { promises as fs } from "node:fs";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { ulid } from "ulid";
import { db, ensureSchema } from "~/db/index.server";
import { alertRules, alertChannels, migrations } from "~/db/schema";
import { config } from "./config.server";
import { tenantOf, platformOrgId } from "./tenant.server";

import { AlertMetric, Comparator, METRIC_META, isAlertMetric, parseRule, type AlertRule, type LogMetric } from "./alert-kinds";
import { EMPTY_NAMES, canonicalName, serviceMatcher, type ServiceNames } from "./service-names";
export { AlertMetric, METRIC_META, isAlertMetric };
export type { AlertRule };

/** Kinds that read container metrics, removed in BAC-49. Stored rules of these
 *  kinds are turned off with RETIRED_NOTE and never evaluated. */
export const RETIRED_METRICS: readonly string[] = ["cpu", "memory_mb", "restarts"];
export const RETIRED_NOTE = "Container metrics are no longer collected, so this rule was turned off. Delete it, or add a rule on error or log rate.";

/** Audit action names of the Alerts page (BAC-72). */
export const AlertAudit = {
  RuleAdd: "alert.rule_add",
  RuleToggle: "alert.rule_toggle",
  RuleDelete: "alert.rule_delete",
  ChannelAdd: "alert.channel_add",
  ChannelToggle: "alert.channel_toggle",
  ChannelDelete: "alert.channel_delete",
  ChannelTest: "alert.channel_test",
} as const;
export type AlertAudit = (typeof AlertAudit)[keyof typeof AlertAudit];

export const DEFAULT_RULES: Omit<AlertRule, "id">[] = [
  { name: "High error rate (any service)", metric: AlertMetric.ErrorRate, service: "*", comparator: Comparator.Above, threshold: 2, channelIds: [], enabled: true },
];

/** A stored rule as the app may use it: a kind that can no longer run comes back disabled with a note. */
export function normalizeRule(rule: AlertRule): AlertRule {
  if (isAlertMetric(rule.metric)) return rule;
  return { ...rule, enabled: false, retired: RETIRED_NOTE };
}

export async function loadRules(orgId: string): Promise<AlertRule[]> {
  await ensureSchema();
  const rows = await db.select({ data: alertRules.data }).from(alertRules).where(eq(alertRules.orgId, orgId));
  // Rules are one JSON blob: checked on read, never cast; a row that is not a rule is skipped.
  return rows.flatMap((r) => {
    const rule = parseRule(r.data);
    return rule ? [normalizeRule(rule)] : [];
  });
}

/** One-time: store retired rules as disabled, with the note, so every reader agrees. */
export async function retireContainerRules(): Promise<number> {
  await ensureSchema();
  const done = await db.select({ name: migrations.name }).from(migrations).where(eq(migrations.name, "alerts_retire_container_v1")).limit(1);
  if (done.length) return 0;
  const rows = await db.select({ id: alertRules.id, orgId: alertRules.orgId, data: alertRules.data }).from(alertRules);
  let changed = 0;
  for (const row of rows) {
    const rule = parseRule(row.data);
    if (!rule || isAlertMetric(rule.metric)) continue;
    const next = normalizeRule(rule);
    await db.update(alertRules).set({ data: next as unknown as Record<string, unknown>, updatedAt: new Date() }).where(and(eq(alertRules.id, row.id), eq(alertRules.orgId, row.orgId)));
    changed += 1;
  }
  await db.insert(migrations).values({ name: "alerts_retire_container_v1" }).onConflictDoNothing();
  return changed;
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

// JSON.stringify escapes quotes/backslashes so a service value can't break out of the
// matcher; org_id scoping is still enforced by loki.scoped.
function lokiSel(service: string, extra: string, names: ServiceNames): string {
  // One service, one name (BAC-51): a service's lines under any of its sources.
  // A rule saved under a container name (before lines were relabelled) means that service too.
  const parts = [extra, service === "*" ? `service=~".+"` : serviceMatcher(canonicalName(service, names.bySource), names)].filter(Boolean);
  return `{${parts.join(",")}}`;
}

/** The LogQL a rule evaluates. Hop records are not log lines, so they never count. */
export function ruleQuery(metric: LogMetric, service: string, names: ServiceNames = EMPTY_NAMES): string {
  switch (metric) {
    case AlertMetric.ErrorRate:
      return `sum(rate(${lokiSel(service, 'kind!="hop",level="error"', names)}[5m]))`;
    case AlertMetric.LogRate:
      return `sum(rate(${lokiSel(service, 'kind!="hop"', names)}[5m]))`;
  }
}

// Granular, single-row DB ops (avoid the read-all/delete-all/insert-all
// lost-update race when two writes overlap — H8).
export async function insertRule(orgId: string, rule: AlertRule): Promise<void> {
  await ensureSchema();
  await db.insert(alertRules).values({ id: rule.id, orgId, data: rule as unknown as Record<string, unknown> });
}
/** Turn a rule on or off; returns the rule as stored, or null when nothing changed. */
export async function toggleRule(orgId: string, id: string): Promise<AlertRule | null> {
  await ensureSchema();
  const rows = await db.select({ data: alertRules.data }).from(alertRules).where(and(eq(alertRules.id, id), eq(alertRules.orgId, orgId))).limit(1);
  if (!rows.length) return null;
  const parsed = parseRule(rows[0].data);
  if (!parsed) return null;
  const r = normalizeRule(parsed);
  if (r.retired) return null; // a retired rule cannot be turned back on
  r.enabled = !r.enabled;
  await db.update(alertRules).set({ data: r as unknown as Record<string, unknown>, updatedAt: new Date() }).where(and(eq(alertRules.id, id), eq(alertRules.orgId, orgId)));
  return r;
}
export async function deleteRule(orgId: string, id: string): Promise<void> {
  await ensureSchema();
  await db.delete(alertRules).where(and(eq(alertRules.id, id), eq(alertRules.orgId, orgId)));
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
