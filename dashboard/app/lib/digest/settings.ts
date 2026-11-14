// Weekly digest settings (BAC-77): the stored shape, the form intents and the form parser. Pure, so
// the settings card (browser) and the route action (server) share one definition.

import { DEFAULT_HOUR_UTC, DEFAULT_WEEKDAY, isHourUtc, isWeekday, type Weekday } from "./schedule";

/** The `intent` values of the settings card's two forms on `/alerts`. */
export const DigestIntent = { Save: "digest_save", Test: "digest_test" } as const;
export type DigestIntent = (typeof DigestIntent)[keyof typeof DigestIntent];
const DIGEST_INTENTS: ReadonlySet<string> = new Set(Object.values(DigestIntent));

export function isDigestIntent(v: unknown): v is DigestIntent {
  return typeof v === "string" && DIGEST_INTENTS.has(v);
}

/** Stored in `digest_settings.email_roles`: who gets the digest by email (besides channels). */
export const DigestEmailRoles = { OwnersAndAdmins: "owner,admin" } as const;
export type DigestEmailRoles = (typeof DigestEmailRoles)[keyof typeof DigestEmailRoles];

/** Channels a digest can go to at most. */
export const DIGEST_MAX_CHANNELS = 10;

export interface DigestSettings {
  enabled: boolean;
  channelIds: string[];
  /** Email the organisation's owners and admins through the system mailer. */
  emailAdmins: boolean;
  weekday: Weekday;
  hourUtc: number;
}

export const DEFAULT_DIGEST_SETTINGS: DigestSettings = {
  enabled: false,
  channelIds: [],
  emailAdmins: false,
  weekday: DEFAULT_WEEKDAY,
  hourUtc: DEFAULT_HOUR_UTC,
};

/** The form fields, as the action reads them. */
export interface DigestFormInput {
  enabled: string | null;
  weekday: string | null;
  hourUtc: string | null;
  channelIds: string[];
  emailAdmins: string | null;
}

export type DigestFormResult = { ok: true; settings: DigestSettings } | { ok: false; error: string };

/** Validate the form against the organisation's own channel ids. */
export function parseDigestForm(f: DigestFormInput, orgChannelIds: ReadonlySet<string>): DigestFormResult {
  const weekday = Number(f.weekday);
  const hourUtc = Number(f.hourUtc);
  if (f.weekday === null || !isWeekday(weekday)) return { ok: false, error: "Choose a day of the week." };
  if (f.hourUtc === null || !isHourUtc(hourUtc)) return { ok: false, error: "Choose an hour from 00 to 23 UTC." };
  const channelIds = [...new Set(f.channelIds)];
  if (channelIds.length > DIGEST_MAX_CHANNELS) return { ok: false, error: `Choose at most ${DIGEST_MAX_CHANNELS} channels.` };
  if (channelIds.some((id) => !orgChannelIds.has(id))) return { ok: false, error: "That channel is not one of this organisation's." };
  const enabled = f.enabled === "on" || f.enabled === "true";
  const emailAdmins = f.emailAdmins === "on" || f.emailAdmins === "true";
  if (enabled && channelIds.length === 0 && !emailAdmins) return { ok: false, error: "Choose a channel or email owners and admins." };
  return { ok: true, settings: { enabled, weekday, hourUtc, channelIds, emailAdmins } };
}
