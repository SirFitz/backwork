import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { defer, json, redirect } from "@remix-run/node";
import { Form, Link, useActionData, useLoaderData, useNavigation } from "@remix-run/react";
import { useState } from "react";
import { Check } from "lucide-react";
import { Card, CardHead, PageTitle } from "~/components/ui";
import { Deferred, RowsSkeleton } from "~/components/defer";
import { Billing, PLANS, PlanId, formatMoney, priceFor, type Plan } from "~/components/site/plans";
import { requireOrg, requireRole, type OrgContext } from "~/lib/auth/context.server";
import { assertSameOrigin } from "~/lib/auth/security.server";
import { logAudit } from "~/lib/audit.server";
import { billing } from "~/lib/billing/index.server";
import { dbStore } from "~/lib/billing/store.server";
import { BillingRefusal } from "~/lib/billing/service.server";
import { InkressBillingError } from "~/lib/billing/inkress.server";
import { effectivePlan, isBilling, isPaidPlanId, trialDaysLeft } from "~/lib/billing/rules";
import { AccountStatus, InkressOrderStatus, type BillingRow, type InkressPeriod } from "~/lib/billing/types";
import { UNMETERED } from "~/lib/plans/limits";
import { billingConfigured, safe } from "~/lib/config.server";
import { cn } from "~/lib/utils";

enum Intent {
  StartTrial = "start_trial",
  Checkout = "checkout",
  ChangePlan = "change_plan",
  KeepPlan = "keep_plan",
  Cancel = "cancel",
  CardUpdate = "card_update",
}

function isIntent(v: string): v is Intent {
  return (Object.values(Intent) as string[]).includes(v);
}

/** What the page needs about the row, with dates as ISO strings for the wire. */
interface AccountView {
  status: AccountStatus;
  plan: PlanId;
  paidPlan: PlanId | null;
  billing: Billing | null;
  trialDaysLeft: number | null;
  trialPlan: PlanId | null;
  everTrialled: boolean;
  periodEnd: string | null;
  pendingPlan: PlanId | null;
  pendingBilling: Billing | null;
  cancelAtPeriodEnd: boolean;
  cardOnFile: boolean;
  awaitingPayment: boolean;
}

function viewOf(row: BillingRow, now: Date): AccountView {
  return {
    status: row.status,
    plan: effectivePlan(row, now),
    paidPlan: row.plan,
    billing: row.billing,
    trialDaysLeft: trialDaysLeft(row, now),
    trialPlan: row.trialPlan,
    everTrialled: row.trialPlan !== null || row.plan !== null,
    periodEnd: row.periodEnd?.toISOString() ?? null,
    pendingPlan: row.pendingPlan,
    pendingBilling: row.pendingBilling,
    cancelAtPeriodEnd: row.cancelAtPeriodEnd,
    cardOnFile: row.cardOnFile,
    awaitingPayment: row.checkoutReference !== null,
  };
}

interface InvoiceView {
  id: number;
  start: string | null;
  end: string | null;
  total: number;
  state: "paid" | "declined" | "due" | "none";
  payUrl: string | null;
}

function invoiceOf(p: InkressPeriod): InvoiceView {
  const state = p.orderStatus === InkressOrderStatus.Paid ? "paid" : p.orderStatus === InkressOrderStatus.Failed ? "declined" : p.orderStatus === InkressOrderStatus.Pending ? "due" : "none";
  return { id: p.id, start: p.start?.toISOString() ?? null, end: p.end?.toISOString() ?? null, total: p.total, state, payUrl: state === "paid" ? null : p.paymentUrl };
}

export async function loader({ request }: LoaderFunctionArgs) {
  const ctx = await requireOrg(request);
  const orgPlan = await dbStore.orgPlan(ctx.org.id);
  if (orgPlan === UNMETERED) return defer({ billed: false as const, orgName: ctx.org.name });

  const service = billing();
  const now = new Date();
  const row = await service.current(ctx.org.id);
  const sync = row.subscriptionUid !== null || row.checkoutReference !== null;
  // Ask Inkress in the background; the page is already on screen with what we hold.
  const account = sync
    ? safe(async () => viewOf(await service.reconcile(ctx.org.id), new Date()), viewOf(row, now))
    : Promise.resolve({ data: viewOf(row, now), error: null });
  const invoices = safe(async () => (await service.invoices(ctx.org.id)).map(invoiceOf), [] as InvoiceView[]);
  return defer({
    billed: true as const,
    orgName: ctx.org.name,
    canManage: ctx.role === "owner" || ctx.role === "admin",
    configured: billingConfigured(),
    initial: viewOf(row, now),
    account,
    invoices,
  });
}

function customerOf(ctx: OrgContext) {
  const [first, ...rest] = (ctx.user.name || ctx.user.email.split("@")[0]).trim().split(/\s+/);
  return { email: ctx.user.email, firstName: first || "Customer", lastName: rest.join(" ") || ctx.org.name };
}

export async function action({ request }: ActionFunctionArgs) {
  assertSameOrigin(request);
  const ctx = await requireOrg(request);
  requireRole(ctx, "admin");
  const fd = await request.formData();
  const intent = String(fd.get("intent") || "");
  if (!isIntent(intent)) return json({ error: "Unknown action." }, { status: 400 });
  const planValue = String(fd.get("plan") || "");
  const billingValue = String(fd.get("billing") || "");
  const service = billing();
  const orgId = ctx.org.id;
  try {
    switch (intent) {
      case Intent.StartTrial: {
        if (!isPaidPlanId(planValue)) return json({ error: "Choose Team or Business." }, { status: 400 });
        await service.startTrial(orgId, planValue);
        await logAudit({ request, orgId, actorUserId: ctx.user.id, action: "billing.trial_started", target: { plan: planValue } });
        return redirect("/billing");
      }
      case Intent.Checkout: {
        if (!isPaidPlanId(planValue) || !isBilling(billingValue)) return json({ error: "Choose a plan and a billing period." }, { status: 400 });
        const { url } = await service.checkout(orgId, planValue, billingValue, customerOf(ctx));
        await logAudit({ request, orgId, actorUserId: ctx.user.id, action: "billing.checkout_opened", target: { plan: planValue, billing: billingValue } });
        return redirect(url);
      }
      case Intent.ChangePlan: {
        if (!isPaidPlanId(planValue) || !isBilling(billingValue)) return json({ error: "Choose a plan and a billing period." }, { status: 400 });
        await service.changePlan(orgId, planValue, billingValue);
        await logAudit({ request, orgId, actorUserId: ctx.user.id, action: "billing.plan_change_scheduled", target: { plan: planValue, billing: billingValue } });
        return redirect("/billing");
      }
      case Intent.KeepPlan: {
        await service.keepPlan(orgId);
        await logAudit({ request, orgId, actorUserId: ctx.user.id, action: "billing.plan_change_dropped" });
        return redirect("/billing");
      }
      case Intent.Cancel: {
        await service.cancel(orgId);
        await logAudit({ request, orgId, actorUserId: ctx.user.id, action: "billing.cancelled" });
        return redirect("/billing");
      }
      case Intent.CardUpdate: {
        return redirect(await service.cardUpdateUrl(orgId));
      }
    }
  } catch (error) {
    if (error instanceof BillingRefusal) return json({ error: error.message }, { status: 400 });
    if (error instanceof InkressBillingError) {
      console.error(JSON.stringify({ msg: "billing: inkress error", orgId, intent, status: error.status, code: error.code, error: error.message }));
      return json({ error: "Our payment provider did not answer. Nothing was charged. Try again in a minute." }, { status: 502 });
    }
    throw error;
  }
}

const fmtDate = (iso: string | null): string => (iso ? new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }) : "");
const planName = (id: PlanId | null): string => PLANS.find((p) => p.id === id)?.name ?? "";

const btnPrimary = "inline-flex h-8 items-center justify-center rounded-lg bg-brand px-3 text-[13px] font-medium text-brand-fg hover:opacity-90 disabled:opacity-60";
const btnSecondary = "inline-flex h-8 items-center justify-center rounded-lg border border-border bg-surface px-3 text-[13px] font-medium hover:bg-surface-2 disabled:opacity-60";

function IntentForm({ intent, plan, billing: cycle, label, className, confirm }: { intent: Intent; plan?: PlanId; billing?: Billing; label: string; className: string; confirm?: string }) {
  const nav = useNavigation();
  const busy = nav.state !== "idle";
  return (
    <Form method="post" onSubmit={confirm ? (e) => { if (!window.confirm(confirm)) e.preventDefault(); } : undefined}>
      <input type="hidden" name="intent" value={intent} />
      {plan ? <input type="hidden" name="plan" value={plan} /> : null}
      {cycle ? <input type="hidden" name="billing" value={cycle} /> : null}
      <button type="submit" disabled={busy} className={className}>{busy ? "Working…" : label}</button>
    </Form>
  );
}

function CurrentPlan({ a, canManage, configured }: { a: AccountView; canManage: boolean; configured: boolean }) {
  const paying = a.status === AccountStatus.Active || a.status === AccountStatus.PastDue;
  const cycle = a.billing === Billing.Yearly ? "year" : "month";
  let line: string;
  if (a.status === AccountStatus.Trialing && a.trialDaysLeft !== null) line = `${a.trialDaysLeft} day${a.trialDaysLeft === 1 ? "" : "s"} left of your free trial. No card needed until you subscribe.`;
  else if (a.status === AccountStatus.PastDue) line = `Your last payment did not go through. Update your card to keep ${planName(a.paidPlan)}.`;
  else if (a.status === AccountStatus.Active && a.cancelAtPeriodEnd) line = `Ends on ${fmtDate(a.periodEnd)}. You will move to Free.`;
  else if (a.status === AccountStatus.Active) line = `Renews on ${fmtDate(a.periodEnd)}${a.paidPlan ? ` at ${formatMoney(priceFor(PLANS.find((p) => p.id === a.paidPlan) as Plan, a.billing ?? Billing.Monthly) ?? 0)} / ${cycle}` : ""}.`;
  else if (a.status === AccountStatus.Cancelled) line = a.plan !== PlanId.Free ? `Cancelled. ${planName(a.plan)} runs until ${fmtDate(a.periodEnd)}.` : "Cancelled.";
  else if (a.awaitingPayment) line = "Waiting for your payment to go through. This page updates when it does.";
  else line = "Free never expires and is never billed. Collection pauses at its limits.";
  return (
    <Card>
      <CardHead
        title={`${planName(a.plan)} plan`}
        sub={a.status === AccountStatus.Trialing ? "free trial" : paying ? (a.billing === Billing.Yearly ? "billed yearly" : "billed monthly") : undefined}
        right={
          canManage && paying ? (
            <div className="flex gap-2">
              {configured ? <IntentForm intent={Intent.CardUpdate} label="Update card" className={btnSecondary} /> : null}
              {!a.cancelAtPeriodEnd ? <IntentForm intent={Intent.Cancel} label="Cancel plan" className={btnSecondary} confirm="Cancel at the end of the paid period? You keep your plan until then, then move to Free." /> : null}
            </div>
          ) : null
        }
      />
      <div className="space-y-2 px-4 py-3 text-[13px]">
        <p className="text-muted">{line}</p>
        {a.pendingPlan ? (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-surface-2 px-3 py-2">
            <span>From {fmtDate(a.periodEnd)} you move to {planName(a.pendingPlan)} ({a.pendingBilling}).</span>
            {canManage ? <IntentForm intent={Intent.KeepPlan} label="Keep current plan" className={btnSecondary} /> : null}
          </div>
        ) : null}
        <p><Link to="/settings" className="text-brand hover:underline">See this month's usage</Link></p>
      </div>
    </Card>
  );
}

function PlanButton({ plan, a, cycle, canManage, configured }: { plan: Plan; a: AccountView; cycle: Billing; canManage: boolean; configured: boolean }) {
  const paying = a.status === AccountStatus.Active || a.status === AccountStatus.PastDue;
  if (plan.id === PlanId.Enterprise) return <a href={plan.cta.href} className={btnSecondary}>{plan.cta.label}</a>;
  if (plan.id === PlanId.Free) {
    return a.plan === PlanId.Free
      ? <span className="text-[13px] text-muted">Your plan</span>
      : paying && !a.cancelAtPeriodEnd && canManage
        ? <IntentForm intent={Intent.Cancel} label="Move to Free" className={btnSecondary} confirm="Move to Free at the end of the paid period?" />
        : null;
  }
  if (!isPaidPlanId(plan.id)) return null;
  if (!canManage) return <span className="text-[13px] text-muted">Ask an owner or admin</span>;
  if (paying) {
    const same = a.paidPlan === plan.id && a.billing === cycle;
    return same ? <span className="text-[13px] text-muted">Your plan</span> : <IntentForm intent={Intent.ChangePlan} plan={plan.id} billing={cycle} label="Switch at renewal" className={btnSecondary} />;
  }
  if (!configured) return <span className="text-[13px] text-muted">Payments open soon</span>;
  const trialing = a.status === AccountStatus.Trialing;
  return (
    <div className="flex flex-wrap gap-2">
      {!a.everTrialled ? <IntentForm intent={Intent.StartTrial} plan={plan.id} label="Start 14-day trial" className={btnSecondary} /> : null}
      <IntentForm intent={Intent.Checkout} plan={plan.id} billing={cycle} label={trialing ? "Subscribe" : "Subscribe and pay"} className={btnPrimary} />
    </div>
  );
}

function Plans({ a, canManage, configured }: { a: AccountView; canManage: boolean; configured: boolean }) {
  const [cycle, setCycle] = useState<Billing>(a.billing ?? Billing.Monthly);
  return (
    <Card>
      <CardHead
        title="Plans"
        sub="US dollars. Yearly is ten months."
        right={
          <div role="radiogroup" aria-label="Billing period" className="inline-flex gap-0.5 rounded-full border border-border bg-bg p-[3px] text-[12.5px]">
            {[Billing.Monthly, Billing.Yearly].map((b) => (
              <button key={b} type="button" role="radio" aria-checked={cycle === b} onClick={() => setCycle(b)} className={cn("rounded-full px-3 py-1", cycle === b ? "bg-surface font-medium text-fg shadow-sm" : "text-muted")}>
                {b === Billing.Monthly ? "Monthly" : "Yearly"}
              </button>
            ))}
          </div>
        }
      />
      <div className="grid gap-px bg-border sm:grid-cols-2 xl:grid-cols-4">
        {PLANS.map((plan) => {
          const price = priceFor(plan, cycle);
          const current = plan.id === a.plan;
          return (
            <div key={plan.id} className="flex flex-col gap-3 bg-surface p-4">
              <div className="flex items-baseline justify-between">
                <h3 className="text-[14px] font-semibold">{plan.name}</h3>
                {current ? <span className="rounded bg-brand/10 px-1.5 py-px text-[11px] font-medium text-brand">Current</span> : null}
              </div>
              <p className="text-[22px] font-semibold tracking-tight">{price === null ? "Custom" : formatMoney(price)}<span className="ml-1 text-[12px] font-normal text-muted">{price ? (cycle === Billing.Yearly ? "/ year" : "/ month") : ""}</span></p>
              <ul className="grid gap-1 text-[12.5px] text-muted">
                {plan.allowance ? <li className="flex gap-1.5"><Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-ok" />{plan.allowance.requestsPerMonth.toLocaleString("en-GB")} requests, {plan.allowance.logGbPerMonth} GB a month</li> : null}
                {plan.retention ? <li className="flex gap-1.5"><Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-ok" />Kept {plan.retention.requestPathsDays} days</li> : null}
                {plan.features.slice(0, 3).map((f) => <li key={f} className="flex gap-1.5"><Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-ok" />{f}</li>)}
              </ul>
              <div className="mt-auto pt-1"><PlanButton plan={plan} a={a} cycle={cycle} canManage={canManage} configured={configured} /></div>
            </div>
          );
        })}
      </div>
    </Card>
  );
}

const STATE_LABEL: Record<InvoiceView["state"], { text: string; tone: string }> = {
  paid: { text: "Paid", tone: "text-ok" },
  declined: { text: "Declined", tone: "text-err" },
  due: { text: "Due", tone: "text-warn" },
  none: { text: "", tone: "" },
};

function Invoices({ items }: { items: InvoiceView[] }) {
  if (!items.length) return <p className="px-4 py-6 text-center text-[13px] text-muted">No invoices yet.</p>;
  return (
    <table className="w-full text-[13px]">
      <thead><tr className="border-b border-border text-left text-xs text-faint"><th className="px-4 py-2 font-medium">Period</th><th className="px-4 py-2 font-medium">Amount</th><th className="px-4 py-2 font-medium">Status</th><th /></tr></thead>
      <tbody>
        {items.map((i) => (
          <tr key={i.id} className="border-b border-border last:border-0">
            <td className="px-4 py-2">{fmtDate(i.start)} to {fmtDate(i.end)}</td>
            <td className="px-4 py-2 font-mono">{formatMoney(i.total)}</td>
            <td className={cn("px-4 py-2", STATE_LABEL[i.state].tone)}>{STATE_LABEL[i.state].text}</td>
            <td className="px-4 py-2 text-right">{i.payUrl ? <a href={i.payUrl} className="text-brand hover:underline">Pay</a> : null}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export default function BillingPage() {
  const d = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  if (!d.billed) {
    return (
      <div className="space-y-4">
        <PageTitle title="Billing" />
        <Card><p className="px-4 py-6 text-[13px] text-muted">{d.orgName} is included by agreement and is not billed.</p></Card>
      </div>
    );
  }
  return (
    <div className="space-y-4">
      <PageTitle title="Billing" sub="Your plan, payments and invoices. Payments are handled by Inkress." />
      {result && "error" in result ? <p role="alert" className="rounded-lg border border-border bg-surface px-4 py-2.5 text-[13px] text-err">{result.error}</p> : null}
      {!d.canManage ? <p className="text-[13px] text-muted">Only owners and admins can change the plan.</p> : null}
      <Deferred
        resolve={d.account}
        fallback={<><CurrentPlan a={d.initial} canManage={d.canManage} configured={d.configured} /><Plans a={d.initial} canManage={d.canManage} configured={d.configured} /></>}
      >
        {(live) => (
          <>
            <CurrentPlan a={live.data} canManage={d.canManage} configured={d.configured} />
            <Plans a={live.data} canManage={d.canManage} configured={d.configured} />
          </>
        )}
      </Deferred>
      <Card>
        <CardHead title="Invoices" />
        <Deferred resolve={d.invoices} fallback={<RowsSkeleton rows={3} />}>{(r) => <Invoices items={r.data} />}</Deferred>
      </Card>
    </div>
  );
}
