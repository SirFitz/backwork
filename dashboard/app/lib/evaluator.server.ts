import * as alerts from "./alerts.server";
import * as channels from "./channels.server";
import { config } from "./config.server";
import { latestDeploy } from "./deploys.server";
import type { Deploy } from "./deploys";
import { tenantOf, type Tenant } from "./tenant.server";
import { AlertMetric, isAlertMetric, ruleForMs, type AlertRule } from "./alert-kinds";
import { AlertNotify, decide, stateChanged } from "./alert-decision";
import { observe, type RuleReading } from "./alert-queries";
import { alertMessage } from "./alert-message";
import { evaluateRule } from "./alerts-eval.server";
import * as state from "./alert-state.server";

// Background alert evaluator (BAC-72). Every minute it reads each enabled rule of each
// organisation, decides with the stored state (`alert_state`) what changes, and on a transition
// claims it in Postgres before sending: with two dashboard processes only the one that wins the
// claim sends, and a restart carries on from the stored state (nothing replayed, nothing lost).
// Every transition leaves an `alert_events` row with what each channel answered.

declare global {
  // eslint-disable-next-line no-var
  var __bwEvaluatorStarted: boolean | undefined;
}

/** How often rules are checked (1 minute). */
export const EVALUATOR_TICK_MS = 60_000;
/** First check after the process starts (8 seconds). */
export const EVALUATOR_FIRST_TICK_MS = 8_000;
/** Slow query rules read the board at most this often per organisation (5 minutes). */
export const SLOW_QUERY_EVAL_MS = 5 * 60_000;
/** A failed send is tried once more after this long (30 seconds). */
export const SEND_RETRY_MS = 30_000;

export interface EvaluatorDeps {
  orgs: () => Promise<string[]>;
  rules: (orgId: string) => Promise<AlertRule[]>;
  states: (orgId: string) => Promise<Map<string, state.StoredAlertState>>;
  read: (rule: AlertRule, tenant: Tenant) => Promise<RuleReading>;
  setPending: typeof state.setPending;
  claim: typeof state.claimTransition;
  recordDelivery: typeof state.recordDelivery;
  channels: (orgId: string) => Promise<channels.Channel[]>;
  send: (channel: channels.Channel, msg: channels.Msg) => Promise<{ ok: boolean; error?: string }>;
  deploy: (orgId: string, service: string) => Promise<Deploy | null>;
  now: () => number;
  publicUrl: string;
  /** Runs `fn` later (the send retry); timers are unref()ed in the real one. */
  later: (fn: () => void, ms: number) => void;
}

export const evaluatorDeps: EvaluatorDeps = {
  orgs: alerts.orgsWithRules,
  rules: alerts.loadRules,
  states: state.loadStates,
  read: (rule, tenant) => evaluateRule(rule, tenant),
  setPending: state.setPending,
  claim: state.claimTransition,
  recordDelivery: state.recordDelivery,
  channels: channels.loadChannels,
  send: channels.send,
  deploy: latestDeploy,
  now: Date.now,
  publicUrl: config.publicUrl,
  later: (fn, ms) => void setTimeout(fn, ms).unref(),
};

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** The service a message names for its deploy clause, or null. */
function deployService(rule: AlertRule, reading: RuleReading): string | null {
  if (rule.metric === AlertMetric.SlowQuery) return reading.query?.service ?? null;
  return rule.route && rule.service !== "*" ? rule.service : null;
}

/** One evaluator: `tick` checks every organisation once. Its slow query cadence is per evaluator. */
export function createEvaluator(deps: EvaluatorDeps = evaluatorDeps) {
  const lastSlowRead = new Map<string, number>();

  async function deliver(orgId: string, eventId: string, rule: AlertRule, msg: channels.Msg, byId: Map<string, channels.Channel>, retry: boolean): Promise<void> {
    const targets = rule.channelIds.map((id) => byId.get(id)).filter((c): c is channels.Channel => !!c && c.enabled);
    if (!targets.length) {
      if (!retry) await deps.recordDelivery(orgId, eventId, {});
      return;
    }
    const results = await Promise.all(targets.map(async (c) => [c, await deps.send(c, msg).catch((e: unknown) => ({ ok: false, error: errorText(e) }))] as const));
    const delivered: state.Delivered = {};
    const failed: channels.Channel[] = [];
    for (const [c, r] of results) {
      delivered[c.id] = r.ok ? state.DELIVERED_OK : (r.error || "failed").slice(0, 300);
      if (!r.ok) failed.push(c);
    }
    await deps.recordDelivery(orgId, eventId, delivered);
    if (failed.length && !retry) {
      const again = new Map(failed.map((c) => [c.id, c]));
      deps.later(() => void deliver(orgId, eventId, { ...rule, channelIds: failed.map((c) => c.id) }, msg, again, true).catch(() => {}), SEND_RETRY_MS);
    }
  }

  async function checkOrg(orgId: string): Promise<void> {
    const tenant = tenantOf(orgId);
    const now = deps.now();
    const [rules, states] = await Promise.all([deps.rules(orgId), deps.states(orgId)]);
    const readSlow = now - (lastSlowRead.get(orgId) ?? -Infinity) >= SLOW_QUERY_EVAL_MS;
    let slowRead = false;
    let byId: Map<string, channels.Channel> | null = null;
    for (const rule of rules) {
      if (!rule.enabled || rule.retired || !isAlertMetric(rule.metric)) continue;
      if (rule.metric === AlertMetric.SlowQuery) {
        if (!readSlow) continue;
        slowRead = true;
      }
      const reading = await deps.read(rule, tenant);
      const prev = states.get(rule.id) ?? null;
      const decision = decide(prev, observe(rule, reading), now, ruleForMs(rule));
      if (decision.notify === null) {
        if (stateChanged(prev, decision.next) && !decision.next.firing) {
          await deps.setPending(orgId, rule.id, decision.next.pendingSince, reading.noData ? null : reading.value);
        }
        continue;
      }
      const claimed = await deps.claim(orgId, rule.id, decision.notify === AlertNotify.Firing, reading.noData ? null : reading.value, now);
      if (!claimed) continue; // another process sent it
      const service = deployService(rule, reading);
      const deploy = service ? await deps.deploy(orgId, service).catch(() => null) : null;
      const m = alertMessage(rule, reading, decision.notify, deploy, now, deps.publicUrl);
      const msg: channels.Msg = { title: m.title, body: m.body, severity: decision.notify === AlertNotify.Firing ? "critical" : "ok", ...(m.link ? { link: m.link } : {}) };
      byId ??= new Map((await deps.channels(orgId).catch((): channels.Channel[] => [])).map((c) => [c.id, c]));
      await deliver(orgId, claimed.eventId, rule, msg, byId, false);
    }
    if (slowRead) lastSlowRead.set(orgId, now);
  }

  async function tick(): Promise<void> {
    let orgIds: string[] = [];
    try {
      orgIds = await deps.orgs();
    } catch {
      return;
    }
    for (const orgId of orgIds) {
      try {
        await checkOrg(orgId);
      } catch (e: unknown) {
        console.error(JSON.stringify({ msg: "alert evaluation failed", orgId, error: errorText(e) }));
      }
    }
  }

  return { tick };
}

export function ensureEvaluator(): void {
  if (globalThis.__bwEvaluatorStarted) return;
  globalThis.__bwEvaluatorStarted = true;
  // Seed first, then turn off any stored rule of a kind that can no longer run (BAC-49).
  void alerts.seedPlatformDefaults().then(() => alerts.retireContainerRules()).catch(() => {});
  const { tick } = createEvaluator();
  let running = false;
  const run = (): void => {
    if (running) return; // a slow tick is never overlapped by the next one
    running = true;
    void tick().finally(() => {
      running = false;
    });
  };
  setTimeout(run, EVALUATOR_FIRST_TICK_MS).unref();
  setInterval(run, EVALUATOR_TICK_MS).unref();
}
