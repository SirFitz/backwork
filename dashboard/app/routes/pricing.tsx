import type { LoaderFunctionArgs, MetaFunction } from "@remix-run/node";
import { json } from "@remix-run/node";
import { Link, useLoaderData } from "@remix-run/react";
import { useId, useState } from "react";
import { Check } from "lucide-react";
import { getUser } from "~/lib/auth/context.server";
import { CONTACT, CtaBand, JsonLd, MarketingShell, NavKey, SITE, Wrap, btnPrimary, btnSecondary, seo } from "~/components/marketing";
import { Billing, EVERY_PLAN, PLANS, PlanId, cheapest, estimateOn, formatMoney, formatRequests, planById, priceFor, type Plan } from "~/components/site/plans";
import { cn } from "~/lib/utils";

export const meta: MetaFunction = () =>
  seo({
    title: "Pricing — backwork",
    description: "Pay for what you send: plans include traced requests and log lines each month. Free plan, no card needed. Team $29, Business $99. Never a surprise bill.",
    path: "/pricing",
  });

export async function loader({ request }: LoaderFunctionArgs) {
  return json({ authed: !!(await getUser(request)) });
}

function PlanCard({ plan, billing }: { plan: Plan; billing: Billing }) {
  const price = priceFor(plan, billing);
  const a = plan.allowance;
  const r = plan.retention;
  const lines: string[] = [];
  if (a) lines.push(`${formatRequests(a.requestsPerMonth)} requests traced a month`, `${a.logGbPerMonth} GB of log lines a month`);
  if (r) lines.push(r.requestPathsDays === r.logLinesDays ? `Kept ${r.requestPathsDays} days` : `Request paths kept ${r.requestPathsDays} days, log lines ${r.logLinesDays}`);
  lines.push(...plan.features);
  const extra = a && a.extraPerMillionRequests !== null && a.extraPerGb !== null
    ? `More: ${formatMoney(a.extraPerMillionRequests)} per million requests, ${formatMoney(a.extraPerGb)} per GB, only with your yes.`
    : null;
  const href = plan.cta.href;
  const ctaClass = cn(plan.featured ? btnPrimary : btnSecondary, "w-full");
  return (
    <article className={cn(
      "flex flex-col rounded-2xl border bg-bg p-6",
      plan.featured ? "border-brand/50 shadow-[0_0_0_3px_oklch(var(--brand)/0.09),0_30px_60px_-34px_oklch(0.2_0.02_265/0.35)]" : "border-border",
    )}>
      <div className="flex items-center justify-between">
        <h3 className="text-[17px] font-semibold">{plan.name}</h3>
        {plan.badge && <span className="rounded bg-brand/10 px-1.5 py-px text-[11px] font-medium text-brand ring-1 ring-inset ring-brand/25">{plan.badge}</span>}
      </div>
      <div className="mt-5 flex items-baseline gap-2">
        <span className="text-[44px] font-semibold leading-none tracking-[-0.03em]">{price === null ? "Custom" : formatMoney(price)}</span>
        {price !== null && price > 0 && <span className="text-[14px] text-muted">{billing === Billing.Yearly ? "/ year" : "/ month"}</span>}
      </div>
      <p className="mb-6 mt-2.5 min-h-[44px] text-[14.5px] text-muted">{plan.tagline}</p>
      {href.startsWith("mailto:") ? <a href={href} className={ctaClass}>{plan.cta.label}</a> : <Link to={href} className={ctaClass}>{plan.cta.label}</Link>}
      <ul className="mt-6 grid gap-2.5 border-t border-border pt-5">
        {lines.map((l) => <li key={l} className="grid grid-cols-[18px_1fr] gap-2.5 text-[14px]"><Check className="mt-[3px] h-4 w-4 text-ok" /><span>{l}</span></li>)}
      </ul>
      {extra && <p className="mt-5 text-[12.5px] text-faint">{extra}</p>}
    </article>
  );
}

// Slider positions map to these steps, so the common small cases get most of the track.
const REQUEST_STEPS = [0, 1_000, 3_000, 10_000, 25_000, 50_000, 100_000, 250_000, 500_000, 1_000_000];
const GB_STEPS = [0, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5];

function Slider({ label, value, steps, index, onChange, format }: {
  label: string; value: string; steps: number[]; index: number; onChange: (i: number) => void; format: (n: number) => string;
}) {
  const id = useId();
  return (
    <div>
      <div className="flex items-baseline justify-between text-[14px] text-muted">
        <label htmlFor={id}>{label}</label><b className="font-mono text-[15px] text-fg">{value}</b>
      </div>
      <input
        id={id} type="range" min={0} max={steps.length - 1} step={1} value={index}
        onChange={(e) => onChange(Number(e.target.value))}
        aria-valuetext={value}
        className="mt-3 w-full accent-[oklch(var(--brand))]"
      />
      <div className="mt-1 flex justify-between font-mono text-[11px] text-faint"><span>{format(steps[0])}</span><span>{format(steps[steps.length - 1])}</span></div>
    </div>
  );
}

function Estimator() {
  const [ri, setRi] = useState(5);
  const [gi, setGi] = useState(7);
  const perDay = REQUEST_STEPS[ri];
  const gbPerDay = GB_STEPS[gi];
  const month = { requests: perDay * 30, gb: Math.round(gbPerDay * 30 * 10) / 10 };
  const best = cheapest(month.requests, month.gb);
  const team = estimateOn(planById(PlanId.Team), month.requests, month.gb);
  const fmtGb = (n: number) => (n < 1 ? `${Math.round(n * 1000)} MB` : `${n} GB`);
  return (
    <div className="mt-5 grid items-center gap-8 rounded-2xl border border-border bg-surface p-6 sm:p-7 lg:grid-cols-[1fr_1.2fr_1fr] lg:gap-10">
      <div>
        <h3 className="text-[18px] font-semibold">What would I pay?</h3>
        <p className="mt-1.5 text-[14px] text-muted">Rough numbers are fine. Your dashboard shows the real ones after the first day.</p>
      </div>
      <div className="grid gap-6">
        <Slider label="Requests a day" value={formatRequests(perDay)} steps={REQUEST_STEPS} index={ri} onChange={setRi} format={formatRequests} />
        <Slider label="Log lines a day" value={fmtGb(gbPerDay)} steps={GB_STEPS} index={gi} onChange={setGi} format={fmtGb} />
      </div>
      <div aria-live="polite">
        <div className="flex items-baseline gap-2">
          <span className="text-[36px] font-semibold leading-none tracking-[-0.03em]">{formatMoney(best.total)}</span>
          <span className="text-[14px] text-muted">/ month on {best.plan.name}</span>
        </div>
        <p className="mt-2 font-mono text-[12.5px] text-faint">{best.breakdown}</p>
        <p className="mt-1.5 text-[14px] text-muted">
          {formatRequests(month.requests)} requests and {fmtGb(month.gb)} a month.
          {best.plan.id === PlanId.Free && team ? " Team adds 30-day request paths and the switches." : ""}
          {best.plan.id === PlanId.Business ? " Business is cheaper than Team with extras at this volume." : ""}
        </p>
      </div>
    </div>
  );
}

const FAQ: [string, string][] = [
  ["What counts as a traced request?", "One request into your services, with every hop it makes. Calls between your own services, and to databases and caches, are part of it and are not counted again."],
  ["What happens near the limit?", "We email you at 80% and at 100%. On a paid plan nothing extra is charged without your yes; on Free, collection pauses until next month."],
  ["How do we keep the bill down?", "Switch off what you don't need, for a project or a single service, from the dashboard. Quieter log levels help too. No developer is needed."],
  ["Can we pay yearly?", "Yes. Pay yearly and get two months free: Team is $290 a year, Business $990."],
  ["Do I need a card to start?", "No. Free needs no card, and the 14-day trial of Team or Business doesn't either."],
  ["Can we leave and take our data?", "Any time. Export your log lines before you go; we delete everything 30 days after you close the account."],
];

export default function Pricing() {
  const { authed } = useLoaderData<typeof loader>();
  const [billing, setBilling] = useState<Billing>(Billing.Monthly);
  return (
    <MarketingShell authed={authed} active={NavKey.Pricing}>
      <JsonLd data={{
        "@context": "https://schema.org", "@type": "Product", name: "backwork", url: `${SITE}/pricing`,
        offers: PLANS.filter((p) => p.monthlyPrice !== null).map((p) => ({ "@type": "Offer", name: p.name, price: String(p.monthlyPrice), priceCurrency: "USD" })),
      }} />
      <section>
        <Wrap className="pb-14 pt-16 text-center sm:pt-24">
          <h1 className="mx-auto text-balance text-[36px] font-semibold leading-[1.06] tracking-[-0.035em] sm:text-[52px]">Pay for what you send. Never a surprise bill.</h1>
          <p className="mx-auto mt-5 max-w-[56ch] text-[17px] leading-relaxed text-muted sm:text-[18px]">Every plan includes a number of traced requests and a volume of log lines each month. We tell you before you reach either.</p>
          <div role="radiogroup" aria-label="Billing" className="mt-7 inline-flex gap-0.5 rounded-full border border-border bg-surface p-[3px] text-[13.5px]">
            {[Billing.Monthly, Billing.Yearly].map((b) => (
              <button key={b} type="button" role="radio" aria-checked={billing === b} onClick={() => setBilling(b)}
                className={cn("rounded-full px-3.5 py-1.5", billing === b ? "bg-bg font-medium text-fg shadow-sm" : "text-muted")}>
                {b === Billing.Monthly ? "Monthly" : <>Yearly <em className="ml-1 font-medium not-italic text-ok">2 months free</em></>}
              </button>
            ))}
          </div>
        </Wrap>
      </section>
      <section className="border-b border-border pb-20 sm:pb-24">
        <Wrap>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">{PLANS.map((p) => <PlanCard key={p.id} plan={p} billing={billing} />)}</div>
          <div className="mt-7 flex flex-wrap items-center gap-x-5 gap-y-2 rounded-2xl border border-border px-5 py-4 text-[14px]">
            <span className="mr-1 font-semibold">Every plan includes</span>
            {EVERY_PLAN.map((i) => <span key={i} className="inline-flex items-center gap-1.5 text-muted"><Check className="h-3.5 w-3.5 text-ok" />{i}</span>)}
          </div>
          <Estimator />
        </Wrap>
      </section>
      <section className="border-b border-border">
        <Wrap className="grid gap-10 py-16 sm:py-20 lg:grid-cols-[280px_1fr] lg:gap-12">
          <h2 className="text-[28px] font-semibold tracking-[-0.025em]">Plain answers</h2>
          <div className="grid gap-7 sm:grid-cols-2 sm:gap-x-10">
            {FAQ.map(([q, a]) => <div key={q}><h3 className="text-[16px] font-semibold">{q}</h3><p className="mt-2 text-[14.5px] text-muted">{a}</p></div>)}
          </div>
        </Wrap>
      </section>
      <CtaBand secondary={{ label: "Talk to us", to: `mailto:${CONTACT}` }} />
    </MarketingShell>
  );
}
