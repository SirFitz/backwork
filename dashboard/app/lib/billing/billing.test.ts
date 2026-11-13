import { beforeEach, describe, expect, test } from "bun:test";
import { Billing, PlanId } from "~/components/site/plans";
import { signHs256, verifyHs256 } from "./jwt.server";
import { effectivePlan, emptyRow, sellsOf, trialDaysLeft } from "./rules";
import { BillingRefusal, createBilling, orgOfReference } from "./service.server";
import { FakeInkress, MemoryStore } from "./testkit";
import { handleBillingWebhook } from "./webhook.server";
import { AccountStatus, InkressOrderStatus, TRIAL_DAYS } from "./types";

const ORG = "01HZZZZZZZZZZZZZZZZZZZZZZA";
const CUSTOMER = { email: "o@example.com", firstName: "Olu", lastName: "Owner" };
const DAY = 86_400_000;

let clock = new Date("2026-11-13T12:00:00Z");
let store: MemoryStore;
let inkress: FakeInkress;
const make = (configured = true) => createBilling({ inkress: inkress.api, store, now: () => clock, configured, returnUrl: "https://bw.test/billing" });

beforeEach(() => {
  clock = new Date("2026-11-13T12:00:00Z");
  store = new MemoryStore();
  store.orgPlans.set(ORG, "free");
  inkress = new FakeInkress();
});

describe("rules", () => {
  test("a trial grants its plan until it ends, then Free", () => {
    const row = { ...emptyRow(ORG), status: AccountStatus.Trialing, trialPlan: PlanId.Team, trialEndsAt: new Date(clock.getTime() + 3 * DAY) };
    expect(effectivePlan(row, clock)).toBe(PlanId.Team);
    expect(trialDaysLeft(row, clock)).toBe(3);
    expect(effectivePlan(row, new Date(clock.getTime() + 4 * DAY))).toBe(PlanId.Free);
  });
  test("a cancelled plan runs to the end of the paid period", () => {
    const row = { ...emptyRow(ORG), status: AccountStatus.Cancelled, plan: PlanId.Business, periodEnd: new Date(clock.getTime() + DAY) };
    expect(effectivePlan(row, clock)).toBe(PlanId.Business);
    expect(effectivePlan(row, new Date(clock.getTime() + 2 * DAY))).toBe(PlanId.Free);
  });
  test("a plan is read from the tags on the Inkress plan, else its name and cycle", () => {
    expect(sellsOf({ name: "x", billingCycle: 3, data: { backwork_plan: "business", backwork_billing: "yearly" } })).toEqual({ plan: PlanId.Business, billing: Billing.Yearly });
    expect(sellsOf({ name: "Team monthly", billingCycle: 3, data: null })).toEqual({ plan: PlanId.Team, billing: Billing.Monthly });
    expect(sellsOf({ name: "Team yearly", billingCycle: 4, data: null })).toEqual({ plan: PlanId.Team, billing: Billing.Yearly });
    expect(sellsOf({ name: "Something else", billingCycle: 3, data: null })).toBeNull();
  });
  test("a checkout reference names its organisation", () => {
    expect(orgOfReference(`bw-${ORG}-01J0000000000000000000000X`)).toBe(ORG);
    expect(orgOfReference("fsb-123")).toBeNull();
  });
});

describe("trial", () => {
  test("starts a 14-day trial, moves the org onto the plan, once only", async () => {
    const b = make();
    const row = await b.startTrial(ORG, PlanId.Team);
    expect(row.trialEndsAt?.getTime()).toBe(clock.getTime() + TRIAL_DAYS * DAY);
    expect(store.orgPlans.get(ORG)).toBe("team");
    await expect(b.startTrial(ORG, PlanId.Business)).rejects.toBeInstanceOf(BillingRefusal);
  });
  test("a finished trial returns the org to Free and stays used up", async () => {
    const b = make();
    await b.startTrial(ORG, PlanId.Team);
    clock = new Date(clock.getTime() + 15 * DAY);
    expect(await b.settleTrials()).toBe(1);
    expect(store.orgPlans.get(ORG)).toBe("free");
    expect((await store.get(ORG))?.status).toBe(AccountStatus.None);
    await expect(b.startTrial(ORG, PlanId.Team)).rejects.toBeInstanceOf(BillingRefusal);
  });
  test("an unmetered organisation is never billed or moved", async () => {
    store.orgPlans.set(ORG, "unmetered");
    const b = make();
    await expect(b.startTrial(ORG, PlanId.Team)).rejects.toBeInstanceOf(BillingRefusal);
    await expect(b.checkout(ORG, PlanId.Team, Billing.Monthly, CUSTOMER)).rejects.toBeInstanceOf(BillingRefusal);
    expect(store.orgPlans.get(ORG)).toBe("unmetered");
  });
  test("an org billing has never touched keeps the plan it has", async () => {
    store.orgPlans.set(ORG, "business");
    await make().reconcile(ORG);
    expect(store.orgPlans.get(ORG)).toBe("business");
  });
});

describe("checkout and subscription", () => {
  test("sends the owner to Inkress, then a paid checkout makes the org a subscriber", async () => {
    const b = make();
    const { url } = await b.checkout(ORG, PlanId.Team, Billing.Monthly, CUSTOMER);
    expect(url).toMatch(/^https:\/\/pay\.test\//);
    const row = await store.get(ORG);
    expect(row?.checkoutReference).toStartWith(`bw-${ORG}-`);
    // Not paid yet: still Free.
    await b.reconcile(ORG);
    expect(store.orgPlans.get(ORG)).toBe("free");
    inkress.pay(row!.checkoutReference!, "p-team-m", ORG, new Date(clock.getTime() + 30 * DAY));
    const after = await b.reconcile(ORG);
    expect(after.status).toBe(AccountStatus.Active);
    expect(after.plan).toBe(PlanId.Team);
    expect(after.checkoutReference).toBeNull();
    expect(store.orgPlans.get(ORG)).toBe("team");
  });
  test("a subscriber during a trial gets the paid plan, and the trial ending changes nothing", async () => {
    const b = make();
    await b.startTrial(ORG, PlanId.Business);
    const { url } = await b.checkout(ORG, PlanId.Team, Billing.Yearly, CUSTOMER);
    expect(url).toBeTruthy();
    const ref = (await store.get(ORG))!.checkoutReference!;
    inkress.pay(ref, "p-team-y", ORG, new Date(clock.getTime() + 365 * DAY));
    await b.reconcile(ORG);
    clock = new Date(clock.getTime() + 20 * DAY);
    await b.settleTrials();
    expect(store.orgPlans.get(ORG)).toBe("team");
  });
  test("refuses a checkout whose Inkress price differs from the price list", async () => {
    inkress.plans = inkress.plans.map((p) => (p.uid === "p-team-m" ? { ...p, price: 35 } : p));
    await expect(make().checkout(ORG, PlanId.Team, Billing.Monthly, CUSTOMER)).rejects.toThrow(/price/);
    expect(inkress.calls.some((c) => c.startsWith("link"))).toBe(false);
  });
  test("refuses a second subscription while one is active", async () => {
    const b = make();
    await b.checkout(ORG, PlanId.Team, Billing.Monthly, CUSTOMER);
    inkress.pay((await store.get(ORG))!.checkoutReference!, "p-team-m", ORG, new Date(clock.getTime() + 30 * DAY));
    await expect(b.checkout(ORG, PlanId.Business, Billing.Monthly, CUSTOMER)).rejects.toBeInstanceOf(BillingRefusal);
  });
  test("does nothing when billing is not configured", async () => {
    await expect(make(false).checkout(ORG, PlanId.Team, Billing.Monthly, CUSTOMER)).rejects.toThrow(/not switched on/);
  });
  test("a declined renewal is past due and keeps the plan while Inkress retries", async () => {
    const b = make();
    await b.checkout(ORG, PlanId.Team, Billing.Monthly, CUSTOMER);
    inkress.pay((await store.get(ORG))!.checkoutReference!, "p-team-m", ORG, new Date(clock.getTime() + 30 * DAY));
    inkress.periods = [{ id: 2, status: 1, start: clock, end: null, total: 29, orderStatus: InkressOrderStatus.Failed, paymentUrl: "https://pay.test/x", cancelCode: null }];
    const row = await b.reconcile(ORG);
    expect(row.status).toBe(AccountStatus.PastDue);
    expect(store.orgPlans.get(ORG)).toBe("team");
  });
  test("a failed Inkress read leaves the plan alone", async () => {
    const b = make();
    await b.checkout(ORG, PlanId.Team, Billing.Monthly, CUSTOMER);
    inkress.pay((await store.get(ORG))!.checkoutReference!, "p-team-m", ORG, new Date(clock.getTime() + 30 * DAY));
    await b.reconcile(ORG);
    inkress.failReads = true;
    await expect(b.reconcile(ORG)).rejects.toThrow();
    expect(store.orgPlans.get(ORG)).toBe("team");
  });
});

describe("changing and ending", () => {
  async function subscribed() {
    const b = make();
    await b.checkout(ORG, PlanId.Team, Billing.Monthly, CUSTOMER);
    inkress.pay((await store.get(ORG))!.checkoutReference!, "p-team-m", ORG, new Date(clock.getTime() + 30 * DAY));
    await b.reconcile(ORG);
    return b;
  }
  test("a plan change is scheduled for the period end and the plan stays", async () => {
    const b = await subscribed();
    const row = await b.changePlan(ORG, PlanId.Business, Billing.Monthly);
    expect(row.pendingPlan).toBe(PlanId.Business);
    expect(row.plan).toBe(PlanId.Team);
    const kept = await b.keepPlan(ORG);
    expect(kept.pendingPlan).toBeNull();
  });
  test("an Inkress refusal is explained", async () => {
    const b = await subscribed();
    inkress.planChangeRefusal = "dunning_in_progress";
    await expect(b.changePlan(ORG, PlanId.Business, Billing.Monthly)).rejects.toThrow(/card/);
  });
  test("cancelling keeps the plan until the paid period ends, then Free", async () => {
    const b = await subscribed();
    inkress.periods = [{ id: 1, status: 1, start: clock, end: null, total: 29, orderStatus: InkressOrderStatus.Paid, paymentUrl: null, cancelCode: "abc123" }];
    const row = await b.cancel(ORG);
    expect(inkress.calls).toContain(`cancel sub-100 abc123`);
    expect(row.status).toBe(AccountStatus.Cancelled);
    expect(store.orgPlans.get(ORG)).toBe("team");
    clock = new Date(clock.getTime() + 31 * DAY);
    await b.reconcile(ORG);
    expect(store.orgPlans.get(ORG)).toBe("free");
  });
  test("the card update link comes from Inkress", async () => {
    const b = await subscribed();
    expect(await b.cardUpdateUrl(ORG)).toBe("https://card.test/sub-100");
  });
});

describe("webhook", () => {
  const SECRET = "whsec";
  const deliver = (claims: Record<string, unknown>, id = "evt-1", type = "subscription.created", secret = SECRET) =>
    new Request("https://bw.test/api/webhooks/inkress/billing", { method: "POST", body: JSON.stringify({ id, type, jwt: signHs256({ id, type, ...claims }, secret) }) });

  async function setup() {
    const b = make();
    await b.checkout(ORG, PlanId.Team, Billing.Monthly, CUSTOMER);
    const ref = (await store.get(ORG))!.checkoutReference!;
    inkress.pay(ref, "p-team-m", ORG, new Date(clock.getTime() + 30 * DAY));
    return { b, ref };
  }

  test("a signed event makes the org a subscriber, and a replay does nothing more", async () => {
    const { b, ref } = await setup();
    const res = await handleBillingWebhook(deliver({ reference_id: ref }), { service: b, store, secret: SECRET });
    expect(res.status).toBe(200);
    expect(store.orgPlans.get(ORG)).toBe("team");
    const again = await handleBillingWebhook(deliver({ reference_id: ref }), { service: b, store, secret: SECRET });
    expect(await again.json()).toMatchObject({ duplicate: true });
  });
  test("finds the org from the subscription tag", async () => {
    const { b } = await setup();
    const res = await handleBillingWebhook(deliver({ data: { subscription: { uid: "unknown", meta_data: { backwork_org_id: ORG } } } }), { service: b, store, secret: SECRET });
    expect(res.status).toBe(200);
    expect(store.orgPlans.get(ORG)).toBe("team");
  });
  test("rejects a wrong signature, a mismatched id and a malformed body", async () => {
    const { b } = await setup();
    expect((await handleBillingWebhook(deliver({}, "e1", "x", "other-secret"), { service: b, store, secret: SECRET })).status).toBe(401);
    const forged = new Request("https://bw.test/w", { method: "POST", body: JSON.stringify({ id: "e2", type: "x", jwt: signHs256({ id: "different" }, SECRET) }) });
    expect((await handleBillingWebhook(forged, { service: b, store, secret: SECRET })).status).toBe(401);
    expect((await handleBillingWebhook(new Request("https://bw.test/w", { method: "POST", body: "nope" }), { service: b, store, secret: SECRET })).status).toBe(400);
    expect((await handleBillingWebhook(new Request("https://bw.test/w", { method: "GET" }), { service: b, store, secret: SECRET })).status).toBe(405);
    expect(store.orgPlans.get(ORG)).toBe("free");
  });
  test("a failed look-again returns 500 and lets Inkress's retry through", async () => {
    const { b, ref } = await setup();
    inkress.failReads = true;
    // The org already has no subscription, so force a read that fails: a subscription uid is stored.
    await b.reconcile(ORG).catch(() => undefined);
    const row = (await store.get(ORG))!;
    await store.save({ ...row, subscriptionUid: "sub-100", checkoutReference: null });
    const first = await handleBillingWebhook(deliver({ reference_id: ref }, "evt-9"), { service: b, store, secret: SECRET });
    expect(first.status).toBe(500);
    inkress.failReads = false;
    const retry = await handleBillingWebhook(deliver({ reference_id: ref }, "evt-9"), { service: b, store, secret: SECRET });
    expect(retry.status).toBe(200);
    expect(store.orgPlans.get(ORG)).toBe("team");
  });
  test("503 without a secret", async () => {
    const { b } = await setup();
    expect((await handleBillingWebhook(deliver({}), { service: b, store, secret: "" })).status).toBe(503);
  });
});

describe("jwt", () => {
  test("verifies a good token, rejects tampering and expiry", () => {
    const t = signHs256({ a: 1, exp: 2_000_000_000 }, "s");
    expect(verifyHs256(t, "s", 1_900_000_000)).toMatchObject({ a: 1 });
    expect(verifyHs256(t, "t", 1_900_000_000)).toBeNull();
    expect(verifyHs256(t, "s", 2_100_000_000)).toBeNull();
    expect(verifyHs256(`${t.slice(0, -2)}xx`, "s")).toBeNull();
    expect(verifyHs256("not.a.token", "s")).toBeNull();
  });
});
