import * as alerts from "./alerts.server";
import * as channels from "./channels.server";

// Background alert evaluator. Runs in the Remix server process: every minute it
// evaluates the rules and, on an ok->firing or firing->ok transition, delivers a
// notification to each of the rule's channels. State is in-memory; the first
// tick seeds a baseline so a deploy doesn't replay every currently-firing rule.

declare global {
  // eslint-disable-next-line no-var
  var __bwEvaluatorStarted: boolean | undefined;
}

const lastFiring = new Map<string, boolean>();
let seeded = false;

async function tick() {
  let states: alerts.AlertState[] = [];
  try {
    states = await alerts.evaluate();
  } catch {
    return;
  }
  if (!seeded) {
    for (const s of states) lastFiring.set(s.id, s.firing);
    seeded = true;
    return;
  }
  const chans = await channels.loadChannels().catch(() => [] as channels.Channel[]);
  const byId = new Map(chans.map((c) => [c.id, c]));
  for (const s of states) {
    const was = lastFiring.get(s.id) || false;
    if (s.firing && !was) await notify(s, byId, "firing");
    else if (!s.firing && was) await notify(s, byId, "resolved");
    lastFiring.set(s.id, s.firing);
  }
}

async function notify(
  rule: alerts.AlertState,
  byId: Map<string, channels.Channel>,
  kind: "firing" | "resolved"
) {
  const meta = alerts.METRIC_META[rule.metric];
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
  setTimeout(() => void tick(), 8000); // seed shortly after boot
  setInterval(() => void tick(), 60000);
}
