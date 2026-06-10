import * as alerts from "./alerts.server";
import * as channels from "./channels.server";
import { tenantOf } from "./tenant.server";

// Background alert evaluator. Runs in the Remix server process: every minute it
// evaluates each org's rules and, on an ok->firing or firing->ok transition,
// delivers a notification to each rule's (org-scoped) channels. State is
// in-memory keyed by org:rule; the first tick seeds a baseline so a deploy
// doesn't replay every currently-firing rule.

declare global {
  // eslint-disable-next-line no-var
  var __bwEvaluatorStarted: boolean | undefined;
}

const lastFiring = new Map<string, boolean>(); // key: `${orgId}:${ruleId}`
let seeded = false;

async function tick() {
  let orgIds: string[] = [];
  try {
    orgIds = await alerts.orgsWithRules();
  } catch {
    return;
  }
  for (const orgId of orgIds) {
    let states: alerts.AlertState[] = [];
    try {
      states = await alerts.evaluate(tenantOf(orgId));
    } catch {
      continue;
    }
    if (!seeded) {
      for (const s of states) lastFiring.set(`${orgId}:${s.id}`, s.firing);
      continue;
    }
    const chans = await channels.loadChannels(orgId).catch(() => [] as channels.Channel[]);
    const byId = new Map(chans.map((c) => [c.id, c]));
    for (const s of states) {
      if (s.noData) continue; // data source unavailable: don't transition (no false fire/resolve)
      const k = `${orgId}:${s.id}`;
      const was = lastFiring.get(k) || false;
      if (s.firing && !was) await notify(s, byId, "firing");
      else if (!s.firing && was) await notify(s, byId, "resolved");
      lastFiring.set(k, s.firing);
    }
  }
  seeded = true;
}

async function notify(
  rule: alerts.AlertState,
  byId: Map<string, channels.Channel>,
  kind: "firing" | "resolved"
) {
  const meta = alerts.METRIC_META[rule.metric];
  if (!meta) return; // unknown/invalid metric — don't crash the notifier
  const scope = rule.service === "*" ? "any service" : rule.service;
  const title = kind === "firing" ? `FIRING: ${rule.name}` : `RESOLVED: ${rule.name}`;
  const body =
    `${scope} — ${meta.label} ${rule.comparator} ${rule.threshold}${meta.unit}` +
    ` (currently ${rule.value.toFixed(2)}${meta.unit})`;
  for (const id of rule.channelIds || []) {
    const ch = byId.get(id);
    if (ch && ch.enabled) {
      await channels.send(ch, { title, body, severity: kind === "firing" ? "critical" : "ok" }).catch(() => {});
    }
  }
}

export function ensureEvaluator() {
  if (globalThis.__bwEvaluatorStarted) return;
  globalThis.__bwEvaluatorStarted = true;
  void alerts.seedPlatformDefaults();
  setTimeout(() => void tick(), 8000); // seed baseline shortly after boot
  setInterval(() => void tick(), 60000);
}
