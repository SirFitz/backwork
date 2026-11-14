// Weekly digest job (BAC-77), started from `startBackgroundJobs()`. Every 15 minutes each process
// checks every enabled organisation: when its week is due (pure `dueCheck`) it claims the week in
// Postgres (`claimRun`), and only the process that wins builds and sends. Whether a digest is due
// comes from the stored runs, never from the timer, so restarts neither skip nor repeat a week.

import { send as sendToChannel, getChannel, type Channel, type Msg } from "~/lib/channels.server";
import { sendMail } from "~/lib/mailer.server";
import { buildDigest, type Digest } from "./build";
import { loadDigestInput, type DigestContext } from "./inputs.server";
import { DIGEST_FIRST_TICK_MS, DIGEST_TICK_MS, dueCheck } from "./schedule";
import type { DigestSettings } from "./settings";
import {
  DELIVERY_OK,
  DeliverySkip,
  DestinationKind,
  MAILER_NOT_CONFIGURED,
  NO_DESTINATIONS,
  destinationKey,
  isSettled,
  type Outcomes,
} from "./delivery";
import { claimRun, enabledDigests, finishRun, ownerAndAdminEmails, type ClaimedRun, type DigestRun, type EnabledDigest, type Recipient } from "./store.server";

/** What a channel is sent: the channel message plus the structured sections (webhooks get every field). */
export type DigestMsg = Msg & { sections: Digest["sections"]; quiet: boolean };

export interface DeliveryDeps {
  channel: (orgId: string, id: string) => Promise<Channel | null>;
  send: (channel: Channel, msg: Msg) => Promise<{ ok: boolean; error?: string }>;
  recipients: (orgId: string) => Promise<Recipient[]>;
  mail: (to: string, subject: string, text: string) => Promise<boolean>;
}

export const defaultDeliveryDeps: DeliveryDeps = {
  channel: getChannel,
  send: sendToChannel,
  recipients: ownerAndAdminEmails,
  mail: sendMail,
};

/** The message one channel gets: email channels the email text, the others the body and link. */
export function channelMessage(channel: Channel, d: Digest): DigestMsg {
  const severity = d.quiet ? "ok" : "warning";
  return channel.type === "email"
    ? { title: d.title, body: d.emailText, severity, sections: d.sections, quiet: d.quiet }
    : { title: d.title, body: d.body, severity, link: d.link, sections: d.sections, quiet: d.quiet };
}

/** Send to every destination not settled in `previous`. One failing destination never stops the
 *  others; each one's answer is returned, merged over `previous`. */
export async function deliverDigest(
  orgId: string,
  settings: DigestSettings,
  digest: Digest,
  previous: Outcomes = {},
  deps: DeliveryDeps = defaultDeliveryDeps,
): Promise<Outcomes> {
  const out: Outcomes = { ...previous };
  const jobs: Array<Promise<void>> = [];
  for (const id of settings.channelIds) {
    const key = destinationKey(DestinationKind.Channel, id);
    if (isSettled(previous[key])) continue;
    jobs.push(
      (async () => {
        try {
          const c = await deps.channel(orgId, id);
          if (!c) out[key] = DeliverySkip.Missing;
          else if (!c.enabled) out[key] = DeliverySkip.Disabled;
          else {
            const r = await deps.send(c, channelMessage(c, digest));
            out[key] = r.ok ? DELIVERY_OK : (r.error || "failed").slice(0, 200);
          }
        } catch (e: unknown) {
          out[key] = e instanceof Error ? e.message.slice(0, 200) : "failed";
        }
      })(),
    );
  }
  if (settings.emailAdmins) {
    jobs.push(
      (async () => {
        let people: Recipient[] = [];
        try {
          people = await deps.recipients(orgId);
        } catch {
          out[destinationKey(DestinationKind.Email, "recipients")] = "could not read owners and admins";
          return;
        }
        for (const p of people) {
          const key = destinationKey(DestinationKind.Email, p.userId);
          if (isSettled(previous[key])) continue;
          try {
            out[key] = (await deps.mail(p.email, digest.title, digest.emailText)) ? DELIVERY_OK : MAILER_NOT_CONFIGURED;
          } catch (e: unknown) {
            out[key] = e instanceof Error ? e.message.slice(0, 200) : "failed";
          }
        }
      })(),
    );
  }
  await Promise.all(jobs);
  return out;
}

export interface TickDeps {
  digests: () => Promise<EnabledDigest[]>;
  claim: (orgId: string, period: string, nowMs: number) => Promise<ClaimedRun | null>;
  finish: (orgId: string, period: string, outcomes: Outcomes, nowMs: number, fallbackError: string) => Promise<DigestRun | null>;
  build: (ctx: DigestContext) => Promise<Digest>;
  deliver: (orgId: string, settings: DigestSettings, digest: Digest, previous: Outcomes) => Promise<Outcomes>;
  clock: () => number;
}

export async function buildFor(ctx: DigestContext): Promise<Digest> {
  return buildDigest(await loadDigestInput(ctx));
}

export const defaultTickDeps: TickDeps = {
  digests: enabledDigests,
  claim: claimRun,
  finish: finishRun,
  build: buildFor,
  deliver: (orgId, settings, digest, previous) => deliverDigest(orgId, settings, digest, previous),
  clock: Date.now,
};

/** What one check did for one organisation. */
export const TickResult = { Sent: "sent", Failed: "failed", NotDue: "not due", Claimed: "claimed elsewhere or done" } as const;
export type TickResult = (typeof TickResult)[keyof typeof TickResult];

export interface TickReport {
  orgId: string;
  periodStart: string;
  result: TickResult;
  outcomes: Outcomes;
}

/** One check over every enabled organisation at `now`. Each organisation fails alone. */
export async function runDigestTick(now: number, deps: TickDeps = defaultTickDeps): Promise<TickReport[]> {
  const out: TickReport[] = [];
  for (const d of await deps.digests()) {
    const due = dueCheck(now, d.settings.weekday, d.settings.hourUtc);
    if (!due.due) {
      out.push({ orgId: d.orgId, periodStart: due.periodStart, result: TickResult.NotDue, outcomes: {} });
      continue;
    }
    try {
      const claimed = await deps.claim(d.orgId, due.periodStart, now);
      if (!claimed) {
        out.push({ orgId: d.orgId, periodStart: due.periodStart, result: TickResult.Claimed, outcomes: {} });
        continue;
      }
      let outcomes: Outcomes = claimed.previous;
      let fallback = NO_DESTINATIONS;
      try {
        const digest = await deps.build({ orgId: d.orgId, orgName: d.orgName, now });
        outcomes = await deps.deliver(d.orgId, d.settings, digest, claimed.previous);
      } catch (e: unknown) {
        fallback = e instanceof Error ? e.message.slice(0, 200) : "build failed";
      }
      const run = await deps.finish(d.orgId, due.periodStart, outcomes, deps.clock(), fallback);
      out.push({ orgId: d.orgId, periodStart: due.periodStart, result: run?.sentAt ? TickResult.Sent : TickResult.Failed, outcomes });
    } catch (e: unknown) {
      console.error(JSON.stringify({ msg: "digest failed", org: d.orgId, error: e instanceof Error ? e.message : String(e) }));
      out.push({ orgId: d.orgId, periodStart: due.periodStart, result: TickResult.Failed, outcomes: {} });
    }
  }
  const due = out.filter((r) => r.result !== TickResult.NotDue);
  if (due.length) console.log(JSON.stringify({ msg: "weekly digest", pid: process.pid, runs: due.map((r) => ({ org: r.orgId, period: r.periodStart, result: r.result })) }));
  return out;
}

/** "Send a test now": builds and sends at once, never claims or records the week. */
export async function sendTestDigest(orgId: string, orgName: string, settings: DigestSettings, now: number = Date.now()): Promise<{ digest: Digest; outcomes: Outcomes }> {
  const digest = await buildFor({ orgId, orgName, now });
  const outcomes = await deliverDigest(orgId, settings, digest);
  return { digest, outcomes };
}

declare global {
  // eslint-disable-next-line no-var
  var __bwDigestJobs: boolean | undefined;
}

/** Start the 15-minute check once per process. */
export function startDigestJobs(): void {
  if (globalThis.__bwDigestJobs) return;
  globalThis.__bwDigestJobs = true;
  const run = (): void => {
    runDigestTick(Date.now()).catch((e: unknown) => console.error(JSON.stringify({ msg: "digest tick failed", error: e instanceof Error ? e.message : String(e) })));
  };
  setTimeout(() => {
    run();
    setInterval(run, DIGEST_TICK_MS).unref();
  }, DIGEST_FIRST_TICK_MS).unref();
}
