// Weekly digest storage (BAC-77): `digest_settings` (one row per organisation) and `digest_runs`
// (one row per organisation and week), both created in the foundation DDL.
//
// A week is claimed before anything is sent: an insert that only one process can win, or, for a
// run that failed, a conditional update that only one process can win once the last attempt is
// an hour old. The process that gets a row back sends; everyone else skips.

import { sql } from "drizzle-orm";
import { db, ensureSchema } from "~/db/index.server";
import { DIGEST_MAX_ATTEMPTS, DIGEST_RETRY_AFTER_MS, DEFAULT_HOUR_UTC, DEFAULT_WEEKDAY, isHourUtc, isWeekday } from "./schedule";
import { DEFAULT_DIGEST_SETTINGS, DigestEmailRoles, type DigestSettings } from "./settings";
import { allSettled, parseOutcomes, type Outcomes } from "./delivery";

/** Audit names of the settings card. */
export const DigestAudit = { Update: "digest.update", Test: "digest.test" } as const;
export type DigestAudit = (typeof DigestAudit)[keyof typeof DigestAudit];

interface SettingsDbRow extends Record<string, unknown> {
  org_id: string;
  enabled: boolean;
  channel_ids: unknown;
  email_roles: string | null;
  weekday: number;
  hour_utc: number;
}

function toSettings(r: SettingsDbRow): DigestSettings {
  const ids = Array.isArray(r.channel_ids) ? r.channel_ids.filter((v): v is string => typeof v === "string") : [];
  return {
    enabled: r.enabled,
    channelIds: ids,
    emailAdmins: r.email_roles === DigestEmailRoles.OwnersAndAdmins,
    weekday: isWeekday(r.weekday) ? r.weekday : DEFAULT_WEEKDAY,
    hourUtc: isHourUtc(r.hour_utc) ? r.hour_utc : DEFAULT_HOUR_UTC,
  };
}

/** The organisation's settings, the defaults (off) when it never saved any. */
export async function loadDigestSettings(orgId: string): Promise<DigestSettings> {
  await ensureSchema();
  const res = await db.execute<SettingsDbRow>(sql`
    SELECT org_id, enabled, channel_ids, email_roles, weekday, hour_utc FROM digest_settings WHERE org_id = ${orgId}`);
  return res.rows[0] ? toSettings(res.rows[0]) : { ...DEFAULT_DIGEST_SETTINGS };
}

export async function saveDigestSettings(orgId: string, s: DigestSettings, userId: string | null): Promise<void> {
  await ensureSchema();
  const roles = s.emailAdmins ? DigestEmailRoles.OwnersAndAdmins : null;
  await db.execute(sql`
    INSERT INTO digest_settings (org_id, enabled, channel_ids, email_roles, weekday, hour_utc, updated_by, updated_at)
    VALUES (${orgId}, ${s.enabled}, ${JSON.stringify(s.channelIds)}::jsonb, ${roles}, ${s.weekday}, ${s.hourUtc}, ${userId}, now())
    ON CONFLICT (org_id) DO UPDATE SET enabled = EXCLUDED.enabled, channel_ids = EXCLUDED.channel_ids,
      email_roles = EXCLUDED.email_roles, weekday = EXCLUDED.weekday, hour_utc = EXCLUDED.hour_utc,
      updated_by = EXCLUDED.updated_by, updated_at = now()`);
}

export interface EnabledDigest {
  orgId: string;
  orgName: string;
  settings: DigestSettings;
}

/** Every organisation with the digest switched on. */
export async function enabledDigests(): Promise<EnabledDigest[]> {
  await ensureSchema();
  const res = await db.execute<SettingsDbRow & { name: string }>(sql`
    SELECT s.org_id, s.enabled, s.channel_ids, s.email_roles, s.weekday, s.hour_utc, o.name
    FROM digest_settings s JOIN orgs o ON o.id = s.org_id WHERE s.enabled ORDER BY s.org_id`);
  return res.rows.map((r) => ({ orgId: r.org_id, orgName: r.name, settings: toSettings(r) }));
}

/** The organisation's name, for the digest title. */
export async function orgName(orgId: string): Promise<string> {
  await ensureSchema();
  const res = await db.execute<{ name: string }>(sql`SELECT name FROM orgs WHERE id = ${orgId}`);
  return res.rows[0]?.name ?? "";
}

export interface DigestRun {
  orgId: string;
  /** YYYY-MM-DD */
  periodStart: string;
  /** epoch ms */
  claimedAt: number;
  sentAt: number | null;
  error: string | null;
  attempts: number;
}

interface RunDbRow extends Record<string, unknown> {
  org_id: string;
  period_start: string;
  claimed_at: Date | string;
  sent_at: Date | string | null;
  error: string | null;
  attempts: number;
}

const RUN_COLUMNS = sql`org_id, to_char(period_start, 'YYYY-MM-DD') AS period_start, claimed_at, sent_at, error, attempts`;

function toRun(r: RunDbRow): DigestRun {
  return {
    orgId: r.org_id,
    periodStart: r.period_start,
    claimedAt: new Date(r.claimed_at).getTime(),
    sentAt: r.sent_at === null ? null : new Date(r.sent_at).getTime(),
    error: r.error,
    attempts: Number(r.attempts),
  };
}

/** A claimed week: the caller sends, then calls `finishRun`. */
export interface ClaimedRun {
  run: DigestRun;
  /** What the earlier attempts answered (empty on the first). */
  previous: Outcomes;
}

/** Claim one organisation's week. Null when another process has it, it was sent, or it failed
 *  `DIGEST_MAX_ATTEMPTS` times or less than `DIGEST_RETRY_AFTER_MS` ago. A run that stopped mid-send
 *  (no `sent_at`, no `error`) is never claimed again: a missed week is better than a double one. */
export async function claimRun(orgId: string, period: string, nowMs: number): Promise<ClaimedRun | null> {
  await ensureSchema();
  const now = new Date(nowMs).toISOString();
  const inserted = await db.execute<RunDbRow>(sql`
    INSERT INTO digest_runs (org_id, period_start, claimed_at, attempts) VALUES (${orgId}, ${period}::date, ${now}::timestamptz, 1)
    ON CONFLICT (org_id, period_start) DO NOTHING RETURNING ${RUN_COLUMNS}`);
  if (inserted.rows[0]) return { run: toRun(inserted.rows[0]), previous: {} };
  const retryBefore = new Date(nowMs - DIGEST_RETRY_AFTER_MS).toISOString();
  const retried = await db.execute<RunDbRow>(sql`
    UPDATE digest_runs SET attempts = attempts + 1, claimed_at = ${now}::timestamptz
    WHERE org_id = ${orgId} AND period_start = ${period}::date AND sent_at IS NULL AND error IS NOT NULL
      AND attempts < ${DIGEST_MAX_ATTEMPTS} AND claimed_at <= ${retryBefore}::timestamptz
    RETURNING ${RUN_COLUMNS}`);
  const row = retried.rows[0];
  return row ? { run: toRun(row), previous: parseOutcomes(row.error) } : null;
}

/** Record what the destinations answered: sent when every one is done, otherwise the outcomes
 *  (or `fallbackError` when there were none) as the error. */
export async function finishRun(orgId: string, period: string, outcomes: Outcomes, nowMs: number, fallbackError: string): Promise<DigestRun | null> {
  await ensureSchema();
  const done = allSettled(outcomes);
  const sentAt = done ? new Date(nowMs).toISOString() : null;
  const error = done ? null : Object.keys(outcomes).length ? JSON.stringify(outcomes) : fallbackError;
  const res = await db.execute<RunDbRow>(sql`
    UPDATE digest_runs SET sent_at = ${sentAt}::timestamptz, error = ${error}
    WHERE org_id = ${orgId} AND period_start = ${period}::date RETURNING ${RUN_COLUMNS}`);
  return res.rows[0] ? toRun(res.rows[0]) : null;
}

/** The organisation's latest run, for the "last sent" line. */
export async function lastRun(orgId: string): Promise<DigestRun | null> {
  await ensureSchema();
  const res = await db.execute<RunDbRow>(sql`
    SELECT ${RUN_COLUMNS} FROM digest_runs WHERE org_id = ${orgId} ORDER BY period_start DESC LIMIT 1`);
  return res.rows[0] ? toRun(res.rows[0]) : null;
}

/** The organisation's latest sent run. */
export async function lastSentRun(orgId: string): Promise<DigestRun | null> {
  await ensureSchema();
  const res = await db.execute<RunDbRow>(sql`
    SELECT ${RUN_COLUMNS} FROM digest_runs WHERE org_id = ${orgId} AND sent_at IS NOT NULL ORDER BY period_start DESC LIMIT 1`);
  return res.rows[0] ? toRun(res.rows[0]) : null;
}

export interface Recipient {
  userId: string;
  email: string;
}

/** The organisation's owners and admins. */
export async function ownerAndAdminEmails(orgId: string): Promise<Recipient[]> {
  await ensureSchema();
  const res = await db.execute<{ user_id: string; email: string }>(sql`
    SELECT u.id AS user_id, u.email FROM memberships m JOIN users u ON u.id = m.user_id
    WHERE m.org_id = ${orgId} AND m.role IN ('owner', 'admin') ORDER BY u.email`);
  return res.rows.map((r) => ({ userId: r.user_id, email: r.email }));
}

/** Occurrences of the given error groups since a time, by group id (bounded by the ids given). */
export async function errorCountsSince(orgId: string, groupIds: readonly string[], sinceMs: number): Promise<Map<string, number>> {
  if (!groupIds.length) return new Map();
  await ensureSchema();
  const since = new Date(sinceMs).toISOString();
  const res = await db.execute<{ group_id: string; n: string | number }>(sql`
    SELECT group_id, count(*) AS n FROM error_events
    WHERE org_id = ${orgId} AND created_at >= ${since}::timestamptz
      AND group_id IN (SELECT jsonb_array_elements_text(${JSON.stringify(groupIds)}::jsonb))
    GROUP BY group_id`);
  return new Map(res.rows.map((r) => [r.group_id, Number(r.n)]));
}
