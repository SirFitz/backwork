// Weekly digest inputs (BAC-77): reads every source of one organisation's digest, each tenant
// scoped, each in its own 30-second budget. A source that fails or runs out of time is named in
// `unavailable` and leaves its section empty; it never fails the digest. Slow Loki sources go
// through their stale-while-revalidate caches, so a value that exists is served at once.

import { config } from "~/lib/config.server";
import { tenantOf, type Tenant } from "~/lib/tenant.server";
import { withBudget } from "~/lib/with-budget";
import { fixFirst, type FixFirstResult } from "~/lib/insights/fix-first.server";
import { FIX_KINDS, FIX_WINDOW_MS, FIX_WINDOW_PHRASE, FixWindow, SOURCE_NAME, SourceState } from "~/lib/insights/fix-first";
import { compareServices } from "~/lib/hops/compare.server";
import { PerfRange } from "~/lib/hops/figures";
import { scanRepeats, type RepeatScan } from "~/lib/hops/repeats.server";
import { listErrorGroups, type ErrGroupRow } from "~/lib/errors.server";
import { loadRules } from "~/lib/alerts.server";
import { recentEvents, AlertEventKind, type AlertEvent } from "~/lib/alert-state.server";
import { deploysBetween, type Deploy } from "~/lib/deploys.server";
import { loadUsageView, type UsageView } from "~/lib/plans/usage-view.server";
import type { CompareRow } from "~/lib/hops/compare";
import { DIGEST_FIX_ITEMS, DIGEST_REPEAT_ITEMS, type DigestAlertEvent, type DigestErrorGroup, type DigestInput, type DigestRepeat, type DigestUsage } from "./build";
import { WEEK_MS } from "./schedule";
import { errorCountsSince } from "./store.server";

/** Each source gets this long (30 seconds), ms. */
export const DIGEST_SOURCE_BUDGET_MS = 30_000;
/** Fix first and the repeats scan read their longest window. */
export const DIGEST_FIX_WINDOW: FixWindow = FixWindow.H6;
/** Open error groups read (most recently seen first). */
export const DIGEST_ERROR_GROUPS_READ = 100;
/** Alert events read per rule. */
export const DIGEST_ALERT_EVENTS_PER_RULE = 40;

/** The source names, as the "Not available this week" line gives them. */
export const DigestSource = {
  FixFirst: "fix first",
  Compare: "compare with last week",
  Repeats: "repeated calls",
  Errors: "errors",
  Alerts: "alert history",
  Deploys: "deploys",
  Usage: "usage",
} as const;
export type DigestSource = (typeof DigestSource)[keyof typeof DigestSource];

export interface WeekAlerts {
  rules: Array<{ id: string; name: string }>;
  events: AlertEvent[];
}

export interface DigestErrorRead {
  groups: ErrGroupRow[];
  /** Occurrences this week by group id. */
  weekCounts: Map<string, number>;
}

/** The readers, injectable for tests. */
export interface DigestSources {
  fixFirst: (tenant: Tenant) => Promise<FixFirstResult>;
  compare: (tenant: Tenant) => Promise<CompareRow[]>;
  repeats: (tenant: Tenant, now: number) => Promise<RepeatScan>;
  errors: (orgId: string, weekStart: number) => Promise<DigestErrorRead>;
  alerts: (orgId: string) => Promise<WeekAlerts>;
  deploys: (orgId: string, fromMs: number, toMs: number) => Promise<Deploy[]>;
  usage: (orgId: string, now: number) => Promise<UsageView | null>;
}

export const defaultDigestSources: DigestSources = {
  fixFirst: (tenant) => fixFirst(tenant, DIGEST_FIX_WINDOW),
  compare: (tenant) => compareServices(PerfRange.H24, tenant),
  repeats: (tenant, now) => scanRepeats(tenant, FIX_WINDOW_MS[DIGEST_FIX_WINDOW], undefined, now),
  errors: async (orgId, weekStart) => {
    const groups = (await listErrorGroups(orgId, { status: "open", limit: DIGEST_ERROR_GROUPS_READ })).filter((g) => new Date(g.lastSeen).getTime() >= weekStart);
    return { groups, weekCounts: await errorCountsSince(orgId, groups.map((g) => g.id), weekStart) };
  },
  alerts: async (orgId) => {
    const [rules, events] = await Promise.all([loadRules(orgId), recentEvents(orgId, DIGEST_ALERT_EVENTS_PER_RULE)]);
    return { rules: rules.map((r) => ({ id: r.id, name: r.name })), events };
  },
  deploys: (orgId, fromMs, toMs) => deploysBetween(orgId, null, fromMs, toMs),
  usage: (orgId, now) => loadUsageView(orgId, now),
};

/** Firings since `weekStart`, each with the resolve that followed it (null while still firing). */
export function weekAlertEvents(a: WeekAlerts, weekStart: number): DigestAlertEvent[] {
  const names = new Map(a.rules.map((r) => [r.id, r.name]));
  const byRule = new Map<string, AlertEvent[]>();
  for (const e of a.events) byRule.set(e.ruleId, [...(byRule.get(e.ruleId) ?? []), e]);
  const out: DigestAlertEvent[] = [];
  for (const [ruleId, events] of byRule) {
    const sorted = [...events].sort((x, y) => x.at - y.at);
    sorted.forEach((e, i) => {
      if (e.kind !== AlertEventKind.Firing || e.at < weekStart) return;
      const resolved = sorted.slice(i + 1).find((n) => n.kind === AlertEventKind.Resolved);
      out.push({ rule: names.get(ruleId) ?? "a deleted rule", firedAt: e.at, resolvedAt: resolved?.at ?? null });
    });
  }
  return out;
}

export function digestErrorGroups(r: DigestErrorRead, weekStart: number): DigestErrorGroup[] {
  return r.groups.map((g) => ({
    type: g.type,
    message: g.message,
    service: g.service,
    isNew: new Date(g.firstSeen).getTime() >= weekStart,
    weekCount: r.weekCounts.get(g.id) ?? 0,
  }));
}

export function digestRepeats(scan: RepeatScan): DigestRepeat[] {
  return scan.rows.slice(0, DIGEST_REPEAT_ITEMS).map((r) => ({ label: r.label, service: r.service, requests: r.requests, medianRepeats: r.medianRepeats, wastedUs: r.wastedUs }));
}

export function digestUsage(v: UsageView | null): DigestUsage | null {
  if (!v) return null;
  return {
    requests: v.month.requests,
    bytes: v.month.bytes,
    includedRequests: v.included?.requests ?? null,
    includedBytes: v.included?.bytes ?? null,
  };
}

type Bounded<T> = { ok: true; value: T } | { ok: false };

/** One source within its budget: a rejection or a timeout reads as unavailable. The value is
 *  boxed, so a source that answers null (an unmetered organisation's usage) is not a timeout. */
async function bounded<T>(fn: () => Promise<T>, budgetMs: number): Promise<Bounded<T>> {
  try {
    const boxed = await withBudget(fn().then((value) => ({ value })), budgetMs);
    return boxed === null ? { ok: false } : { ok: true, value: boxed.value };
  } catch {
    return { ok: false };
  }
}

export interface DigestContext {
  orgId: string;
  orgName: string;
  /** When the digest is built (epoch ms). */
  now: number;
}

/** Everything one organisation's digest needs. Never rejects. */
export async function loadDigestInput(
  ctx: DigestContext,
  sources: DigestSources = defaultDigestSources,
  budgetMs: number = DIGEST_SOURCE_BUDGET_MS,
  baseUrl: string = config.publicUrl,
): Promise<DigestInput> {
  const { orgId, now } = ctx;
  const tenant = tenantOf(orgId);
  const weekStart = now - WEEK_MS;
  const [fix, compare, repeats, errors, alerts, deploys, usage] = await Promise.all([
    bounded(() => sources.fixFirst(tenant), budgetMs),
    bounded(() => sources.compare(tenant), budgetMs),
    bounded(() => sources.repeats(tenant, now), budgetMs),
    bounded(() => sources.errors(orgId, weekStart), budgetMs),
    bounded(() => sources.alerts(orgId), budgetMs),
    bounded(() => sources.deploys(orgId, weekStart, now), budgetMs),
    bounded(() => sources.usage(orgId, now), budgetMs),
  ]);
  const unavailable = new Set<string>();
  if (!fix.ok) unavailable.add(DigestSource.FixFirst);
  else for (const kind of FIX_KINDS) if (fix.value.sources[kind] === SourceState.Unavailable) unavailable.add(SOURCE_NAME[kind].toLowerCase());
  if (!compare.ok) unavailable.add(DigestSource.Compare);
  if (!repeats.ok) unavailable.add(DigestSource.Repeats);
  if (!errors.ok) unavailable.add(DigestSource.Errors);
  if (!alerts.ok) unavailable.add(DigestSource.Alerts);
  if (!deploys.ok) unavailable.add(DigestSource.Deploys);
  if (!usage.ok) unavailable.add(DigestSource.Usage);
  const base = baseUrl.replace(/\/+$/, "");
  return {
    orgName: ctx.orgName,
    now,
    weekStart,
    insightsUrl: `${base}/insights`,
    settingsUrl: `${base}/alerts`,
    fixFirst: fix.ok ? fix.value.items.slice(0, DIGEST_FIX_ITEMS) : [],
    fixWindowPhrase: FIX_WINDOW_PHRASE[DIGEST_FIX_WINDOW],
    regressions: compare.ok ? compare.value : [],
    newRepeats: repeats.ok && !repeats.value.statementsOff ? digestRepeats(repeats.value) : [],
    repeatsSampled: repeats.ok && repeats.value.truncated,
    repeatsWindowPhrase: FIX_WINDOW_PHRASE[DIGEST_FIX_WINDOW],
    errorGroups: errors.ok ? digestErrorGroups(errors.value, weekStart) : [],
    alertEvents: alerts.ok ? weekAlertEvents(alerts.value, weekStart) : [],
    deploys: deploys.ok ? deploys.value : [],
    usage: usage.ok ? digestUsage(usage.value) : null,
    unavailable: [...unavailable],
  };
}
