import { describe, expect, test } from "bun:test";
import { Billing, PlanId } from "~/components/site/plans";
import { createBilling } from "~/lib/billing/service.server";
import { FakeInkress, MemoryStore } from "~/lib/billing/testkit";
import { AccountStatus, InkressOrderStatus } from "~/lib/billing/types";
import { emptyRow } from "~/lib/billing/rules";
import { billingFacts } from "./billing-facts";
import { analyticsConfig, DEFAULT_SCRIPT_URL } from "./config.server";
import { withAnalyticsOrigin } from "./csp.server";
import { FirstDataAge, ServerEvent, type ServerFact } from "./events";
import { firstDataAge } from "./first-data.server";
import { isTrackableLocation } from "./paths";
import { buildEvent, eventId, SERVER_AGENT, trackServer, type FetchLike } from "./server.server";

const KEY = "fl_pub_" + "a".repeat(24);
const ENV = { FLATLYTICS_SITE_KEY: KEY, FLATLYTICS_SECRET_KEY: "fl_sec_x" } as NodeJS.ProcessEnv;
const loc = (pathname: string, search = "", hash = "") => ({ pathname, search, hash });

describe("config", () => {
  test("no key, or a bad key, means off", () => {
    expect(analyticsConfig({} as NodeJS.ProcessEnv)).toBeNull();
    expect(analyticsConfig({ FLATLYTICS_SITE_KEY: "nope" } as NodeJS.ProcessEnv)).toBeNull();
  });
  test("defaults the script url, refuses http, reads the secret and test mode", () => {
    const cfg = analyticsConfig({ ...ENV, FLATLYTICS_TEST_MODE: "1" });
    expect(cfg?.scriptUrl).toBe(DEFAULT_SCRIPT_URL);
    expect(cfg?.secretKey).toBe("fl_sec_x");
    expect(cfg?.testMode).toBe(true);
    expect(analyticsConfig({ ...ENV, FLATLYTICS_SCRIPT_URL: "http://x.test/f.js" })).toBeNull();
    expect(analyticsConfig({ FLATLYTICS_SITE_KEY: KEY } as NodeJS.ProcessEnv)?.secretKey).toBeNull();
  });
});

describe("paths: only bare allow-listed screens", () => {
  test.each(["/", "/pricing", "/register", "/billing", "/requests", "/projects/"])("%s is tracked", (p) => expect(isTrackableLocation(loc(p))).toBe(true));
  test.each([
    ["/requests/01HABC"], ["/traces/abc"], ["/errors/abc"], ["/invite/tok"], ["/reset/tok"], ["/logs"], ["/settings"], ["/api-keys"], ["/ingest/records"], ["/requests_/abc"],
  ])("%s is not", (p) => expect(isTrackableLocation(loc(p))).toBe(false));
  test("a query string or fragment is never tracked", () => {
    expect(isTrackableLocation(loc("/requests", "?q=user@example.com"))).toBe(false);
    expect(isTrackableLocation(loc("/billing", "?env=prod"))).toBe(false);
    expect(isTrackableLocation(loc("/", "", "#key"))).toBe(false);
  });
});

describe("csp", () => {
  const base = "default-src 'self'; script-src 'self' 'unsafe-inline'; connect-src 'self'; frame-src https://x.test";
  test("unchanged when analytics is off", () => expect(withAnalyticsOrigin(base, {} as NodeJS.ProcessEnv)).toBe(base));
  test("names the ingest origin in script-src and connect-src only", () => {
    const out = withAnalyticsOrigin(base, ENV);
    expect(out).toContain("script-src 'self' 'unsafe-inline' https://flatlytics-ingest.silent-voice-a285.workers.dev;");
    expect(out).toContain("connect-src 'self' https://flatlytics-ingest.silent-voice-a285.workers.dev;");
    expect(out).toContain("frame-src https://x.test");
  });
});

describe("server events", () => {
  test("ids are 32 lowercase hex; a dedupe key gives the same id every time", () => {
    expect(eventId()).toMatch(/^[0-9a-f]{32}$/);
    expect(eventId()).not.toBe(eventId());
    expect(eventId("sub:1")).toBe(eventId("sub:1"));
    expect(eventId("sub:1")).toMatch(/^[0-9a-f]{32}$/);
  });
  test("an event carries the key, a fixed page and only its props", () => {
    const cfg = analyticsConfig(ENV)!;
    const e = buildEvent(cfg, { name: ServerEvent.ProjectCreated, props: { first: true } }, "https://backwork.dev");
    expect(e).toMatchObject({ k: KEY, e: "project_created", u: "https://backwork.dev/projects", p: { first: true } });
  });
  test("posts with the secret key and one fixed user agent; off without a secret", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchFn: FetchLike = async (url, init) => { calls.push({ url, init }); return { ok: true, status: 202 }; };
    trackServer(ServerEvent.LoginFailed, { method: "email" as never, reason: "invalid_credentials" }, { env: ENV, fetchFn });
    trackServer(ServerEvent.LoginFailed, { method: "email" as never, reason: "x" }, { env: { FLATLYTICS_SITE_KEY: KEY } as NodeJS.ProcessEnv, fetchFn });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://flatlytics-ingest.silent-voice-a285.workers.dev/api/server");
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer fl_sec_x");
    expect(headers["user-agent"]).toBe(SERVER_AGENT);
  });
  test("a fact with a dedupe key is sent once per process", () => {
    const calls: string[] = [];
    const fetchFn: FetchLike = async (_u, init) => { calls.push(String(init.body)); return { ok: true, status: 202 }; };
    for (let i = 0; i < 3; i++) trackServer(ServerEvent.SubscriptionCancelled, {}, { env: ENV, fetchFn, dedupeKey: "cancel:dedupe-test" });
    expect(calls).toHaveLength(1);
  });
  test("a failing network never throws", () => {
    const fetchFn: FetchLike = async () => { throw new Error("down"); };
    expect(() => trackServer(ServerEvent.ProjectCreated, { first: false }, { env: ENV, fetchFn })).not.toThrow();
  });
});

describe("first data", () => {
  test("buckets by project age and ignores old projects", () => {
    expect(firstDataAge(5 * 60_000)).toBe(FirstDataAge.UnderHour);
    expect(firstDataAge(5 * 3_600_000)).toBe(FirstDataAge.UnderDay);
    expect(firstDataAge(3 * 86_400_000)).toBe(FirstDataAge.UnderWeek);
    expect(firstDataAge(30 * 86_400_000)).toBeNull();
  });
});

const ORG = "01HZZZZZZZZZZZZZZZZZZZZZZA";
const names = (f: ServerFact[]) => f.map((x) => x.name);

describe("billing facts", () => {
  test("a trial, a checkout, a paid subscription, a declined renewal and a cancel each give one fact", () => {
    const none = emptyRow(ORG);
    const trial = { ...none, status: AccountStatus.Trialing, trialPlan: PlanId.Team as const };
    expect(names(billingFacts(none, trial))).toEqual([ServerEvent.TrialStarted]);
    const open = { ...trial, checkoutReference: "bw-1", checkoutPlan: PlanId.Team as const, checkoutBilling: Billing.Monthly };
    expect(billingFacts(trial, open)).toEqual([{ name: ServerEvent.CheckoutOpened, props: { plan: "team", billing: "monthly" } }]);
    const paid = { ...open, checkoutReference: null, subscriptionUid: "sub-1", status: AccountStatus.Active, plan: PlanId.Team as const, billing: Billing.Monthly };
    const started = billingFacts(open, paid);
    expect(started).toEqual([{ name: ServerEvent.SubscriptionStarted, props: { plan: "team", billing: "monthly", after_trial: true }, dedupeKey: "sub:sub-1" }]);
    expect(billingFacts(paid, paid)).toEqual([]);
    expect(names(billingFacts(paid, { ...paid, status: AccountStatus.PastDue }))).toEqual([ServerEvent.RenewalDeclined]);
    expect(names(billingFacts(paid, { ...paid, cancelAtPeriodEnd: true }))).toEqual([ServerEvent.SubscriptionCancelled]);
  });
  test("an open checkout that clears with no subscription is a failed checkout", () => {
    const open = { ...emptyRow(ORG), checkoutReference: "bw-1", checkoutPlan: PlanId.Team as const, checkoutBilling: Billing.Monthly };
    expect(names(billingFacts(open, { ...open, checkoutReference: null, checkoutPlan: null, checkoutBilling: null }))).toEqual([ServerEvent.CheckoutFailed]);
  });
  test("no fact carries an id, an email or free text", () => {
    const paid = { ...emptyRow(ORG), subscriptionUid: "sub-9", status: AccountStatus.Active, plan: PlanId.Business as const, billing: Billing.Yearly as const };
    for (const f of billingFacts(emptyRow(ORG), paid)) expect(JSON.stringify(f.props)).not.toMatch(/sub-9|01HZ|@/);
  });
});

describe("billing service tells the observer", () => {
  const CUSTOMER = { email: "o@example.com", firstName: "Olu", lastName: "Owner" };
  test("trial, checkout, payment and a failed checkout, end to end on the fakes", async () => {
    const store = new MemoryStore();
    store.orgPlans.set(ORG, "free");
    const inkress = new FakeInkress();
    const seen: string[] = [];
    const clock = new Date("2026-11-13T12:00:00Z");
    const b = createBilling({ inkress: inkress.api, store, now: () => clock, configured: true, returnUrl: "https://bw.test/billing", embedOrigin: "https://bw.test", observe: (x, y) => seen.push(...billingFacts(x, y).map((f) => f.name)) });
    await b.startTrial(ORG, PlanId.Team);
    await b.checkout(ORG, PlanId.Team, Billing.Monthly, CUSTOMER);
    const ref = (await store.get(ORG))!.checkoutReference!;
    inkress.pay(ref, "p-team-m", ORG, new Date(clock.getTime() + 30 * 86_400_000));
    await b.confirmCheckout(ORG);
    await b.reconcile(ORG);
    expect(seen).toEqual([ServerEvent.TrialStarted, ServerEvent.CheckoutOpened, ServerEvent.SubscriptionStarted]);

    const store2 = new MemoryStore();
    store2.orgPlans.set(ORG, "free");
    const inkress2 = new FakeInkress();
    const seen2: string[] = [];
    const b2 = createBilling({ inkress: inkress2.api, store: store2, now: () => clock, configured: true, returnUrl: "x", embedOrigin: "https://bw.test", observe: (x, y) => seen2.push(...billingFacts(x, y).map((f) => f.name)) });
    await b2.checkout(ORG, PlanId.Team, Billing.Monthly, CUSTOMER);
    const ref2 = (await store2.get(ORG))!.checkoutReference!;
    inkress2.orders.get(ref2)!.status = InkressOrderStatus.Failed;
    await b2.confirmCheckout(ORG);
    expect(seen2).toEqual([ServerEvent.CheckoutOpened, ServerEvent.CheckoutFailed]);
  });
  test("an observer that throws never breaks billing", async () => {
    const store = new MemoryStore();
    store.orgPlans.set(ORG, "free");
    const b = createBilling({ inkress: new FakeInkress().api, store, now: () => new Date(), configured: true, returnUrl: "x", embedOrigin: "https://bw.test", observe: () => { throw new Error("boom"); } });
    await expect(b.startTrial(ORG, PlanId.Team)).resolves.toBeDefined();
  });
});
