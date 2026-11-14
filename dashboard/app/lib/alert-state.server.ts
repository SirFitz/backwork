// Durable alert state and history (BAC-72): `alert_state` (one row per rule) and `alert_events`
// (one row per transition), both created in the foundation DDL.
//
// A transition is claimed with one conditional upsert: the row only changes when its stored
// `firing` differs from the new one, and only the caller that gets the row back sends. Two
// processes evaluating the same rule at the same time therefore send once, and a restart loads
// the stored state instead of re-baselining.

import { sql } from "drizzle-orm";
import { ulid } from "ulid";
import { db, ensureSchema } from "~/db/index.server";
import { AlertNotify, type AlertStateRow } from "./alert-decision";

/** The value set of `alert_events.kind`. */
export const AlertEventKind = AlertNotify;
export type AlertEventKind = AlertNotify;

/** What each channel answered: "ok" or the error text, by channel id. */
export type Delivered = Record<string, string>;

/** The answer that means a channel took the message. */
export const DELIVERED_OK = "ok";

/** Events kept on the page per rule. */
export const EVENTS_PER_RULE = 5;

export interface StoredAlertState extends AlertStateRow {
  value: number | null;
  /** When the current firing (or resolved) state began, epoch ms. */
  since: number | null;
  lastNotifiedAt: number | null;
}

export interface AlertEvent {
  id: string;
  ruleId: string;
  kind: AlertEventKind;
  value: number | null;
  /** epoch ms */
  at: number;
  /** Null until the sends finished (a process that stopped mid-send leaves it null). */
  delivered: Delivered | null;
}

interface StateDbRow extends Record<string, unknown> {
  rule_id: string;
  firing: boolean;
  value: number | null;
  since: Date | string | null;
  last_notified_at: Date | string | null;
  pending_since: Date | string | null;
}

interface EventDbRow extends Record<string, unknown> {
  id: string;
  rule_id: string;
  kind: string;
  value: number | null;
  at: Date | string;
  delivered: unknown;
}

function ms(v: Date | string | null): number | null {
  return v === null ? null : new Date(v).getTime();
}

function iso(v: number | null): string | null {
  return v === null ? null : new Date(v).toISOString();
}

function toState(r: StateDbRow): StoredAlertState {
  return {
    firing: r.firing,
    pendingSince: ms(r.pending_since),
    value: r.value,
    since: ms(r.since),
    lastNotifiedAt: ms(r.last_notified_at),
  };
}

function isEventKind(v: string): v is AlertEventKind {
  return v === AlertEventKind.Firing || v === AlertEventKind.Resolved;
}

function parseDelivered(v: unknown): Delivered | null {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
  const out: Delivered = {};
  for (const [k, val] of Object.entries(v)) if (typeof val === "string") out[k] = val;
  return out;
}

function toEvent(r: EventDbRow): AlertEvent | null {
  if (!isEventKind(r.kind)) return null;
  return { id: r.id, ruleId: r.rule_id, kind: r.kind, value: r.value, at: new Date(r.at).getTime(), delivered: parseDelivered(r.delivered) };
}

/** The stored state of every rule of an organisation, by rule id. */
export async function loadStates(orgId: string): Promise<Map<string, StoredAlertState>> {
  await ensureSchema();
  const res = await db.execute<StateDbRow>(sql`
    SELECT rule_id, firing, value, since, last_notified_at, pending_since FROM alert_state WHERE org_id = ${orgId}`);
  return new Map(res.rows.map((r) => [r.rule_id, toState(r)]));
}

/**
 * Store a pending change (a breach starting or ending its wait) without touching `firing`. A
 * start keeps an earlier pending time (two processes writing it agree on the first) and never
 * touches a firing row; a clear only empties the pending time. A missing row is created not firing.
 */
export async function setPending(orgId: string, ruleId: string, pendingSince: number | null, value: number | null): Promise<void> {
  await ensureSchema();
  if (pendingSince === null) {
    await db.execute(sql`
      UPDATE alert_state SET pending_since = NULL, value = ${value}
      WHERE org_id = ${orgId} AND rule_id = ${ruleId} AND pending_since IS NOT NULL`);
    return;
  }
  await db.execute(sql`
    INSERT INTO alert_state (org_id, rule_id, firing, value, pending_since)
    VALUES (${orgId}, ${ruleId}, false, ${value}, ${iso(pendingSince)}::timestamptz)
    ON CONFLICT (org_id, rule_id) DO UPDATE
      SET pending_since = COALESCE(alert_state.pending_since, EXCLUDED.pending_since), value = EXCLUDED.value
      WHERE NOT alert_state.firing`);
}

/** A claimed transition: the event row to fill in once the sends are done. */
export interface ClaimedTransition {
  eventId: string;
  state: StoredAlertState;
}

/**
 * Claim one transition. Firing is a conditional upsert (the row changes only when it is not
 * firing already); resolved updates only a firing row. The event row is written in the same
 * transaction. Returns null when another process (or an earlier tick) already made this
 * transition: the caller must not send.
 */
export async function claimTransition(orgId: string, ruleId: string, firing: boolean, value: number | null, nowMs: number): Promise<ClaimedTransition | null> {
  await ensureSchema();
  const now = new Date(nowMs).toISOString();
  return db.transaction(async (tx) => {
    const res = firing
      ? await tx.execute<StateDbRow>(sql`
          INSERT INTO alert_state (org_id, rule_id, firing, value, since, last_notified_at, pending_since)
          VALUES (${orgId}, ${ruleId}, true, ${value}, ${now}::timestamptz, ${now}::timestamptz, NULL)
          ON CONFLICT (org_id, rule_id) DO UPDATE
            SET firing = EXCLUDED.firing, value = EXCLUDED.value, since = EXCLUDED.since,
                last_notified_at = EXCLUDED.last_notified_at, pending_since = NULL
            WHERE alert_state.firing <> EXCLUDED.firing
          RETURNING rule_id, firing, value, since, last_notified_at, pending_since`)
      : await tx.execute<StateDbRow>(sql`
          UPDATE alert_state
            SET firing = false, value = ${value}, since = ${now}::timestamptz, last_notified_at = ${now}::timestamptz, pending_since = NULL
          WHERE org_id = ${orgId} AND rule_id = ${ruleId} AND firing
          RETURNING rule_id, firing, value, since, last_notified_at, pending_since`);
    const row = res.rows[0];
    if (!row) return null;
    const eventId = ulid();
    const kind = firing ? AlertEventKind.Firing : AlertEventKind.Resolved;
    await tx.execute(sql`
      INSERT INTO alert_events (id, org_id, rule_id, kind, value, at) VALUES (${eventId}, ${orgId}, ${ruleId}, ${kind}, ${value}, ${now}::timestamptz)`);
    return { eventId, state: toState(row) };
  });
}

/** Record what each channel answered for one event (merged into earlier answers, for the retry). */
export async function recordDelivery(orgId: string, eventId: string, delivered: Delivered): Promise<void> {
  await ensureSchema();
  await db.execute(sql`
    UPDATE alert_events SET delivered = COALESCE(delivered, '{}'::jsonb) || ${JSON.stringify(delivered)}::jsonb
    WHERE org_id = ${orgId} AND id = ${eventId}`);
}

/** The last `perRule` events of every rule of an organisation, newest first. */
export async function recentEvents(orgId: string, perRule: number = EVENTS_PER_RULE): Promise<AlertEvent[]> {
  await ensureSchema();
  const res = await db.execute<EventDbRow>(sql`
    SELECT id, rule_id, kind, value, at, delivered FROM (
      SELECT id, rule_id, kind, value, at, delivered, row_number() OVER (PARTITION BY rule_id ORDER BY at DESC, id DESC) AS n
      FROM alert_events WHERE org_id = ${orgId}) e
    WHERE n <= ${perRule} ORDER BY at DESC, id DESC`);
  return res.rows.map(toEvent).filter((e): e is AlertEvent => e !== null);
}

/** Forget a rule's state (rule turned off or deleted): turning it back on starts afresh. */
export async function clearState(orgId: string, ruleId: string): Promise<void> {
  await ensureSchema();
  await db.execute(sql`DELETE FROM alert_state WHERE org_id = ${orgId} AND rule_id = ${ruleId}`);
}

/** Remove a deleted rule's state and history. */
export async function forgetRule(orgId: string, ruleId: string): Promise<void> {
  await ensureSchema();
  await db.transaction(async (tx) => {
    await tx.execute(sql`DELETE FROM alert_state WHERE org_id = ${orgId} AND rule_id = ${ruleId}`);
    await tx.execute(sql`DELETE FROM alert_events WHERE org_id = ${orgId} AND rule_id = ${ruleId}`);
  });
}
