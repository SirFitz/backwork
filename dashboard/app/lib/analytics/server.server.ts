// Server-side events: facts the browser cannot see (an account created, a payment confirmed, the first
// lines arriving). Content-free: fixed names, flat props, no ids or text. Fire-and-forget; analytics never
// fails or slows a request. No identity is sent: one fixed User-Agent, so these are goals (counts), not
// funnel steps.
import { createHash, randomBytes } from "node:crypto";
import { config } from "~/lib/config.server";
import { analyticsConfig, type AnalyticsServerConfig } from "./config.server";
import { ServerEvent, type EventProp, type ServerEventProps, type ServerFact } from "./events";

const SEND_TIMEOUT_MS = 2000;
const SEEN_LIMIT = 5000;

/** The screen each event relates to. Fixed paths, never an id. */
const EVENT_PATH: Record<ServerEvent, string> = {
  [ServerEvent.SignupCompleted]: "/register",
  [ServerEvent.SignupFailed]: "/register",
  [ServerEvent.LoginFailed]: "/login",
  [ServerEvent.OrganizationCreated]: "/onboarding",
  [ServerEvent.ProjectCreated]: "/projects",
  [ServerEvent.FirstDataReceived]: "/projects",
  [ServerEvent.AlertCreated]: "/alerts",
  [ServerEvent.TrialStarted]: "/billing",
  [ServerEvent.CheckoutOpened]: "/billing",
  [ServerEvent.SubscriptionStarted]: "/billing",
  [ServerEvent.CheckoutFailed]: "/billing",
  [ServerEvent.RenewalDeclined]: "/billing",
  [ServerEvent.SubscriptionCancelled]: "/billing",
};

export type FetchLike = (url: string, init: RequestInit) => Promise<{ ok: boolean; status: number }>;

/** One fixed User-Agent for every server event: no per-account identity is sent (BRIEF rule 4). */
export const SERVER_AGENT = "backwork-server";

export interface ServerEventBody {
  i: string;
  k: string;
  e: string;
  u: string;
  p: Record<string, EventProp>;
}

/** 32 lowercase hex chars: random, or derived from a dedupe key so a repeated fact keeps one id. */
export function eventId(dedupeKey?: string): string {
  return dedupeKey ? createHash("sha256").update(dedupeKey).digest("hex").slice(0, 32) : randomBytes(16).toString("hex");
}

export function buildEvent(cfg: AnalyticsServerConfig, fact: ServerFact, eventOrigin: string): ServerEventBody {
  return { i: eventId(fact.dedupeKey), k: cfg.siteKey, e: fact.name, u: `${eventOrigin}${EVENT_PATH[fact.name]}`, p: fact.props as Record<string, EventProp> };
}

const sentKeys = new Set<string>();

export function trackServer<E extends ServerEvent>(
  name: E,
  props: ServerEventProps[E],
  opts: { dedupeKey?: string; env?: NodeJS.ProcessEnv; fetchFn?: FetchLike } = {},
): void {
  try {
    const env = opts.env ?? process.env;
    const cfg = analyticsConfig(env);
    if (!cfg || !cfg.secretKey) return;
    if (opts.dedupeKey) {
      const key = `${name}:${opts.dedupeKey}`;
      if (sentKeys.has(key)) return;
      if (sentKeys.size >= SEEN_LIMIT) sentKeys.clear();
      sentKeys.add(key);
    }
    const origin = (env.FLATLYTICS_EVENT_ORIGIN ?? "").trim() || new URL(config.publicUrl).origin;
    const body = JSON.stringify(buildEvent(cfg, { name, props, dedupeKey: opts.dedupeKey } as ServerFact, origin));
    const send = opts.fetchFn ?? ((url, init) => fetch(url, init));
    void send(`${cfg.origin}/api/server`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${cfg.secretKey}`, "user-agent": SERVER_AGENT },
      body,
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    }).catch(() => undefined);
  } catch {
    // never let analytics fail a request
  }
}

/** Hand a fact (from billing or ingest hooks) to trackServer. */
export function trackFact(fact: ServerFact): void {
  trackServer(fact.name, fact.props as never, { dedupeKey: fact.dedupeKey });
}
