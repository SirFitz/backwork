// The weekly digest card's action on `/alerts` (BAC-77): save the settings or send a test now.
// Admins and owners only; channels must be the organisation's own; both intents are audited. The
// route checks the origin and the session, then hands the form here.

import type { Role } from "~/db/schema";
import { hasRole } from "~/lib/auth/context.server";
import { logAudit } from "~/lib/audit.server";
import { loadChannels } from "~/lib/channels.server";
import { DigestIntent, parseDigestForm, type DigestSettings } from "./settings";
import { DELIVERY_OK, DestinationKind, outcomeLine, type Outcomes } from "./delivery";
import { DigestAudit, loadDigestSettings, orgName, saveDigestSettings } from "./store.server";
import { sendTestDigest } from "./schedule.server";

/** The lowest role that may change or test the digest. */
export const DIGEST_MIN_ROLE: Role = "admin";

/** What the card's fetchers get back. */
export type DigestActionResult =
  | { intent: typeof DigestIntent.Save; ok: true }
  | { intent: typeof DigestIntent.Save; ok: false; error: string }
  | { intent: typeof DigestIntent.Test; ok: boolean; line: string; quiet: boolean };

export interface DigestActor {
  orgId: string;
  userId: string;
  role: Role;
}

export interface DigestActionDeps {
  channelIds: (orgId: string) => Promise<Array<{ id: string; name: string }>>;
  save: (orgId: string, s: DigestSettings, userId: string) => Promise<void>;
  load: (orgId: string) => Promise<DigestSettings>;
  orgName: (orgId: string) => Promise<string>;
  test: (orgId: string, orgName: string, s: DigestSettings) => Promise<{ outcomes: Outcomes; quiet: boolean }>;
  audit: (action: DigestAudit, target: Record<string, unknown>) => void;
}

export function defaultDigestActionDeps(request: Request, actor: DigestActor): DigestActionDeps {
  return {
    channelIds: async (orgId) => (await loadChannels(orgId)).map((c) => ({ id: c.id, name: c.name })),
    save: (orgId, s, userId) => saveDigestSettings(orgId, s, userId),
    load: loadDigestSettings,
    orgName,
    test: async (orgId, name, s) => {
      const r = await sendTestDigest(orgId, name, s);
      return { outcomes: r.outcomes, quiet: r.digest.quiet };
    },
    audit: (action, target) => void logAudit({ request, orgId: actor.orgId, actorUserId: actor.userId, action, target }),
  };
}

/** Names for the outcome line: channel names, "email to owners and admins". */
export function destinationName(key: string, channels: ReadonlyMap<string, string>): string {
  const at = key.indexOf(":");
  const kind = key.slice(0, at);
  const id = key.slice(at + 1);
  if (kind === DestinationKind.Channel) return channels.get(id) ?? "a removed channel";
  return "email to an owner or admin";
}

/** Handle one digest intent. Throws a 403 Response below `DIGEST_MIN_ROLE`. */
export async function handleDigestAction(actor: DigestActor, intent: DigestIntent, fd: FormData, deps: DigestActionDeps): Promise<DigestActionResult> {
  if (!hasRole(actor.role, DIGEST_MIN_ROLE)) throw new Response("Forbidden: requires admin", { status: 403 });
  const chans = await deps.channelIds(actor.orgId);
  const names = new Map(chans.map((c) => [c.id, c.name]));
  if (intent === DigestIntent.Save) {
    const parsed = parseDigestForm(
      {
        enabled: str(fd.get("enabled")),
        weekday: str(fd.get("weekday")),
        hourUtc: str(fd.get("hourUtc")),
        channelIds: fd.getAll("channelIds").map(String),
        emailAdmins: str(fd.get("emailAdmins")),
      },
      new Set(names.keys()),
    );
    if (!parsed.ok) return { intent: DigestIntent.Save, ok: false, error: parsed.error };
    await deps.save(actor.orgId, parsed.settings, actor.userId);
    deps.audit(DigestAudit.Update, { ...parsed.settings });
    return { intent: DigestIntent.Save, ok: true };
  }
  // Test: send with the stored settings, never claiming the week.
  const settings = await deps.load(actor.orgId);
  const own = { ...settings, channelIds: settings.channelIds.filter((id) => names.has(id)) };
  if (own.channelIds.length === 0 && !own.emailAdmins) {
    return { intent: DigestIntent.Test, ok: false, line: "Choose a channel or email owners and admins, then save, to send a test.", quiet: false };
  }
  const r = await deps.test(actor.orgId, await deps.orgName(actor.orgId), own);
  const ok = Object.values(r.outcomes).some((v) => v === DELIVERY_OK);
  deps.audit(DigestAudit.Test, { outcomes: r.outcomes });
  return { intent: DigestIntent.Test, ok, line: outcomeLine(r.outcomes, (k) => destinationName(k, names)), quiet: r.quiet };
}

function str(v: FormDataEntryValue | null): string | null {
  return typeof v === "string" ? v : null;
}
