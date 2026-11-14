import { describe, expect, test } from "bun:test";
import type { Channel, Msg } from "~/lib/channels.server";
import { buildDigest, type Digest } from "./build";
import { DELIVERY_OK, DeliverySkip, MAILER_NOT_CONFIGURED, type Outcomes } from "./delivery";
import { TickResult, channelMessage, deliverDigest, runDigestTick, type DeliveryDeps, type TickDeps } from "./schedule.server";
import { DEFAULT_DIGEST_SETTINGS, type DigestSettings } from "./settings";
import type { ClaimedRun, DigestRun } from "./store.server";

const NOW = Date.UTC(2026, 10, 16, 8, 5); // Monday 08:05 UTC

function digest(): Digest {
  return buildDigest({
    orgName: "Org",
    now: NOW,
    weekStart: NOW - 7 * 86_400_000,
    insightsUrl: "http://localhost/insights",
    settingsUrl: "http://localhost/alerts",
    fixFirst: [],
    fixWindowPhrase: "last 6 hours",
    regressions: [],
    newRepeats: [],
    repeatsSampled: false,
    repeatsWindowPhrase: "last 6 hours",
    errorGroups: [],
    alertEvents: [],
    deploys: [],
    usage: null,
    unavailable: [],
  });
}

function chan(id: string, type: Channel["type"], enabled = true): Channel {
  return { id, name: id, type, enabled, config: {} };
}

function deliveryDeps(over: Partial<DeliveryDeps> = {}, sent: Array<{ id: string; msg: Msg }> = []): DeliveryDeps {
  const chans = new Map([chan("hook", "webhook"), chan("slack", "slack"), chan("bad", "webhook"), chan("off", "webhook", false), chan("mail", "email")].map((c) => [c.id, c]));
  return {
    channel: async (_org, id) => chans.get(id) ?? null,
    send: async (c, msg) => {
      sent.push({ id: c.id, msg });
      return c.id === "bad" ? { ok: false, error: "HTTP 500" } : { ok: true };
    },
    recipients: async () => [{ userId: "u1", email: "owner@example.test" }],
    mail: async () => true,
    ...over,
  };
}

const settings = (over: Partial<DigestSettings> = {}): DigestSettings => ({ ...DEFAULT_DIGEST_SETTINGS, enabled: true, ...over });

describe("deliverDigest", () => {
  test("one failing channel does not stop the others, and each answer is recorded", async () => {
    const sent: Array<{ id: string; msg: Msg }> = [];
    const out = await deliverDigest("o", settings({ channelIds: ["bad", "hook", "slack", "off", "gone"], emailAdmins: true }), digest(), {}, deliveryDeps({}, sent));
    expect(out).toEqual({
      "channel:bad": "HTTP 500",
      "channel:hook": DELIVERY_OK,
      "channel:slack": DELIVERY_OK,
      "channel:off": DeliverySkip.Disabled,
      "channel:gone": DeliverySkip.Missing,
      "email:u1": DELIVERY_OK,
    });
    expect(sent.map((s) => s.id).sort()).toEqual(["bad", "hook", "slack"]);
  });

  test("a retry sends only to the destinations that failed", async () => {
    const sent: Array<{ id: string; msg: Msg }> = [];
    const previous: Outcomes = { "channel:bad": "HTTP 500", "channel:hook": DELIVERY_OK, "email:u1": DELIVERY_OK };
    let mails = 0;
    const out = await deliverDigest("o", settings({ channelIds: ["bad", "hook"], emailAdmins: true }), digest(), previous, deliveryDeps({ mail: async () => (mails++, true) }, sent));
    expect(sent.map((s) => s.id)).toEqual(["bad"]);
    expect(mails).toBe(0);
    expect(out["channel:hook"]).toBe(DELIVERY_OK);
  });

  test("a throwing channel and an unconfigured mailer are recorded, not thrown", async () => {
    const out = await deliverDigest("o", settings({ channelIds: ["hook"], emailAdmins: true }), digest(), {}, deliveryDeps({
      send: async () => {
        throw new Error("socket hang up");
      },
      mail: async () => false,
    }));
    expect(out).toEqual({ "channel:hook": "socket hang up", "email:u1": MAILER_NOT_CONFIGURED });
  });

  test("message shapes: Slack and webhooks get the body, link and sections; email channels the email text", () => {
    const d = digest();
    const hook = channelMessage(chan("h", "webhook"), d);
    expect(hook).toMatchObject({ title: d.title, body: d.body, link: d.link, quiet: true, severity: "ok" });
    expect(JSON.parse(JSON.stringify(hook)).sections).toEqual(d.sections);
    const mail = channelMessage(chan("m", "email"), d);
    expect(mail.body).toBe(d.emailText);
    expect(mail.link).toBeUndefined();
  });
});

describe("runDigestTick", () => {
  function tickDeps(state: { runs: Map<string, DigestRun>; delivered: number }, over: Partial<TickDeps> = {}): TickDeps {
    return {
      digests: async () => [{ orgId: "o1", orgName: "Org", settings: settings({ weekday: 1, hourUtc: 8, channelIds: ["hook"] }) }],
      claim: async (orgId, period, nowMs): Promise<ClaimedRun | null> => {
        const key = `${orgId}:${period}`;
        if (state.runs.has(key)) return null;
        const run: DigestRun = { orgId, periodStart: period, claimedAt: nowMs, sentAt: null, error: null, attempts: 1 };
        state.runs.set(key, run);
        return { run, previous: {} };
      },
      finish: async (orgId, period, outcomes, nowMs) => {
        const run = state.runs.get(`${orgId}:${period}`);
        if (!run) return null;
        const ok = Object.values(outcomes).every((v) => v === DELIVERY_OK);
        Object.assign(run, ok ? { sentAt: nowMs, error: null } : { error: JSON.stringify(outcomes) });
        return run;
      },
      build: async () => digest(),
      deliver: async () => {
        state.delivered++;
        return { "channel:hook": DELIVERY_OK };
      },
      clock: () => NOW,
      ...over,
    };
  }

  test("due: claims, sends once, records; a second tick sends nothing", async () => {
    const state = { runs: new Map<string, DigestRun>(), delivered: 0 };
    const deps = tickDeps(state);
    expect((await runDigestTick(NOW, deps))[0]).toMatchObject({ periodStart: "2026-11-16", result: TickResult.Sent });
    expect((await runDigestTick(NOW + 15 * 60_000, deps))[0].result).toBe(TickResult.Claimed);
    expect(state.delivered).toBe(1);
    expect(state.runs.get("o1:2026-11-16")?.sentAt).toBe(NOW);
  });

  test("not due before the hour or a day after it", async () => {
    const state = { runs: new Map<string, DigestRun>(), delivered: 0 };
    expect((await runDigestTick(Date.UTC(2026, 10, 16, 7, 59), tickDeps(state)))[0].result).toBe(TickResult.NotDue);
    expect((await runDigestTick(Date.UTC(2026, 10, 17, 8, 0), tickDeps(state)))[0].result).toBe(TickResult.NotDue);
    expect(state.delivered).toBe(0);
  });

  test("a build that throws is recorded as the run's error", async () => {
    const state = { runs: new Map<string, DigestRun>(), delivered: 0 };
    let fallback = "";
    const r = await runDigestTick(NOW, tickDeps(state, {
      build: async () => {
        throw new Error("loki down");
      },
      finish: async (orgId, period, outcomes, nowMs, fb) => {
        fallback = fb;
        return { orgId, periodStart: period, claimedAt: nowMs, sentAt: null, error: fb, attempts: 1 };
      },
    }));
    expect(r[0].result).toBe(TickResult.Failed);
    expect(fallback).toBe("loki down");
    expect(state.delivered).toBe(0);
  });

  test("one organisation failing does not stop the next", async () => {
    const state = { runs: new Map<string, DigestRun>(), delivered: 0 };
    const quiet = console.error;
    console.error = () => {};
    try {
      const r = await runDigestTick(NOW, tickDeps(state, {
        digests: async () => [
          { orgId: "bad", orgName: "Bad", settings: settings({ channelIds: ["hook"] }) },
          { orgId: "o2", orgName: "Org 2", settings: settings({ channelIds: ["hook"] }) },
        ],
        claim: async (orgId, period, nowMs) => {
          if (orgId === "bad") throw new Error("db gone");
          return { run: { orgId, periodStart: period, claimedAt: nowMs, sentAt: null, error: null, attempts: 1 }, previous: {} };
        },
        finish: async (orgId, period, _o, nowMs) => ({ orgId, periodStart: period, claimedAt: nowMs, sentAt: nowMs, error: null, attempts: 1 }),
      }));
      expect(r.map((x) => x.result)).toEqual([TickResult.Failed, TickResult.Sent]);
    } finally {
      console.error = quiet;
    }
  });
});
