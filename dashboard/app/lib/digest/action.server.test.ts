import { describe, expect, test } from "bun:test";
import { handleDigestAction, type DigestActionDeps, type DigestActor } from "./action.server";
import { DELIVERY_OK } from "./delivery";
import { DEFAULT_DIGEST_SETTINGS, DigestIntent, type DigestSettings } from "./settings";
import { DigestAudit } from "./store.server";

function form(fields: Record<string, string | string[]>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) for (const x of Array.isArray(v) ? v : [v]) fd.append(k, x);
  return fd;
}

interface Calls {
  saved: DigestSettings[];
  audits: Array<{ action: DigestAudit; target: Record<string, unknown> }>;
  tests: DigestSettings[];
}

function deps(calls: Calls, stored: DigestSettings = DEFAULT_DIGEST_SETTINGS): DigestActionDeps {
  return {
    channelIds: async () => [{ id: "c1", name: "Ops hook" }],
    save: async (_o, s) => {
      calls.saved.push(s);
    },
    load: async () => stored,
    orgName: async () => "Org",
    test: async (_o, _n, s) => {
      calls.tests.push(s);
      return { outcomes: { "channel:c1": DELIVERY_OK, "email:u1": "mailer not configured" }, quiet: true };
    },
    audit: (action, target) => {
      calls.audits.push({ action, target });
    },
  };
}

const admin: DigestActor = { orgId: "o", userId: "u", role: "admin" };
const good = { enabled: "on", weekday: "1", hourUtc: "8", channelIds: "c1" };

describe("digest settings action", () => {
  test("a member is refused with 403, nothing saved", async () => {
    const calls: Calls = { saved: [], audits: [], tests: [] };
    for (const role of ["member", "viewer"] as const) {
      let status = 0;
      try {
        await handleDigestAction({ ...admin, role }, DigestIntent.Save, form(good), deps(calls));
      } catch (e: unknown) {
        status = e instanceof Response ? e.status : -1;
      }
      expect(status).toBe(403);
    }
    expect(calls.saved).toHaveLength(0);
    expect(calls.audits).toHaveLength(0);
  });

  test("an admin or owner saves, and the change is audited", async () => {
    for (const role of ["admin", "owner"] as const) {
      const calls: Calls = { saved: [], audits: [], tests: [] };
      const r = await handleDigestAction({ ...admin, role }, DigestIntent.Save, form({ ...good, emailAdmins: "on" }), deps(calls));
      expect(r).toEqual({ intent: DigestIntent.Save, ok: true });
      expect(calls.saved).toEqual([{ enabled: true, weekday: 1, hourUtc: 8, channelIds: ["c1"], emailAdmins: true }]);
      expect(calls.audits[0].action).toBe(DigestAudit.Update);
    }
  });

  test("a channel from another organisation is refused", async () => {
    const calls: Calls = { saved: [], audits: [], tests: [] };
    const r = await handleDigestAction(admin, DigestIntent.Save, form({ ...good, channelIds: ["c1", "other-org-channel"] }), deps(calls));
    expect(r).toEqual({ intent: DigestIntent.Save, ok: false, error: "That channel is not one of this organisation's." });
    expect(calls.saved).toHaveLength(0);
  });

  test("bad day or hour, and on with nowhere to send", async () => {
    const calls: Calls = { saved: [], audits: [], tests: [] };
    expect(await handleDigestAction(admin, DigestIntent.Save, form({ ...good, weekday: "7" }), deps(calls))).toMatchObject({ ok: false, error: "Choose a day of the week." });
    expect(await handleDigestAction(admin, DigestIntent.Save, form({ ...good, hourUtc: "24" }), deps(calls))).toMatchObject({ ok: false });
    expect(await handleDigestAction(admin, DigestIntent.Save, form({ enabled: "on", weekday: "1", hourUtc: "8" }), deps(calls))).toMatchObject({
      ok: false,
      error: "Choose a channel or email owners and admins.",
    });
    // off with nothing chosen is fine
    expect(await handleDigestAction(admin, DigestIntent.Save, form({ weekday: "1", hourUtc: "8" }), deps(calls))).toMatchObject({ ok: true });
  });

  test("send a test: uses the stored settings, only own channels, audited, with a result line", async () => {
    const calls: Calls = { saved: [], audits: [], tests: [] };
    const stored: DigestSettings = { ...DEFAULT_DIGEST_SETTINGS, channelIds: ["c1", "stale"], emailAdmins: true };
    const r = await handleDigestAction(admin, DigestIntent.Test, form({}), deps(calls, stored));
    expect(r).toEqual({ intent: DigestIntent.Test, ok: true, quiet: true, line: "Sent to Ops hook; email to an owner or admin failed: mailer not configured" });
    expect(calls.tests[0].channelIds).toEqual(["c1"]);
    expect(calls.audits.map((a) => a.action)).toEqual([DigestAudit.Test]);
  });

  test("send a test with nowhere to send says so", async () => {
    const calls: Calls = { saved: [], audits: [], tests: [] };
    const r = await handleDigestAction(admin, DigestIntent.Test, form({}), deps(calls));
    expect(r).toMatchObject({ ok: false, line: "Choose a channel or email owners and admins, then save, to send a test." });
    expect(calls.tests).toHaveLength(0);
  });
});
