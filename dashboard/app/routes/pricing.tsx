import type { LoaderFunctionArgs, MetaFunction } from "@remix-run/node";
import { json } from "@remix-run/node";
import { Link, useLoaderData } from "@remix-run/react";
import { ArrowRight, Check, Github } from "lucide-react";
import { getUser } from "~/lib/auth/context.server";
import { MarketingShell, seo, SITE, REPO } from "~/components/marketing";
import { cn } from "~/lib/utils";

export const meta: MetaFunction = () =>
  seo({
    title: "Pricing — backwork",
    description: "Self-host backwork for free, or let us run it for you. Transparent plans for the whole observability stack — no per-GB surprises.",
    path: "/pricing",
  });

export async function loader({ request }: LoaderFunctionArgs) {
  return json({ authed: !!(await getUser(request)) });
}

const TIERS = [
  {
    name: "Self-host",
    price: "Free",
    unit: "forever",
    blurb: "The whole stack, on your own hardware. Open source.",
    cta: { label: "Get the code", href: REPO, external: true },
    highlight: false,
    features: ["Logs, metrics, traces, requests, incidents & alerts", "Unlimited hosts, projects & retention (your disk)", "Organizations, teams & roles", "OpenTelemetry-native ingest", "One Docker-Compose deploy", "Community support on GitHub"],
  },
  {
    name: "Cloud",
    price: "$19",
    unit: "/ host / mo",
    blurb: "Managed backwork — we run, scale and back it up.",
    cta: { label: "Start free", href: "/register", external: false },
    highlight: true,
    features: ["Everything in Self-host, fully managed", "Automatic upgrades & backups", "14-day metrics / 7-day log retention", "Multi-tenant orgs & per-project tokens", "Email alert channels included", "Email support, 1-business-day"],
  },
  {
    name: "Enterprise",
    price: "Custom",
    unit: "annual",
    blurb: "For teams with compliance, scale and SLA needs.",
    cta: { label: "Contact sales", href: "mailto:hello@backwork.dev?subject=backwork%20Enterprise", external: true },
    highlight: false,
    features: ["SSO / SAML & SCIM provisioning", "Custom retention & data residency", "Audit logs & role policies", "Priority support & uptime SLA", "Dedicated or air-gapped deployment", "Onboarding & migration help"],
  },
];

const FAQ = [
  ["Is the self-hosted version really free?", "Yes — the full stack is open source. Clone the repo, run one Docker command, and use every feature with no license cost."],
  ["What does “per host” mean on Cloud?", "A host is any server or machine sending telemetry to backwork. Containers and apps on the same host don't count separately."],
  ["Do you charge per GB of logs?", "No. We price on hosts, not data volume, so a traffic spike never spikes your bill."],
  ["Can I move between self-host and Cloud?", "Anytime. It's the same software, so you can start self-hosted and switch to managed (or back) without changing your agents."],
];

export default function Pricing() {
  const { authed } = useLoaderData<typeof loader>();
  return (
    <MarketingShell authed={authed} active="pricing">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify({
        "@context": "https://schema.org", "@type": "Product", name: "backwork",
        description: "Self-hosted logs, metrics and traces in one dashboard.", url: SITE + "/pricing",
        offers: TIERS.map((t) => ({ "@type": "Offer", name: t.name, price: t.price === "Free" ? "0" : t.price === "Custom" ? undefined : t.price.replace("$", ""), priceCurrency: "USD" })),
      }) }} />

      <section className="mx-auto max-w-6xl px-5 pt-16 pb-10 text-center sm:px-6 lg:pt-24">
        <div data-reveal>
          <div className="inline-flex items-center gap-1.5 rounded-full border border-border bg-surface px-3 py-1 text-2xs font-medium text-muted"><span className="h-1.5 w-1.5 rounded-full bg-brand" />Pricing</div>
          <h1 className="mx-auto mt-5 max-w-2xl text-4xl font-semibold leading-tight tracking-tight sm:text-5xl">Free to self-host. Pay only for convenience.</h1>
          <p className="mx-auto mt-5 max-w-xl text-[15px] leading-relaxed text-muted sm:text-base">Run the entire stack yourself at no cost, or let us host, scale and back it up. Either way you're never billed per gigabyte.</p>
        </div>
      </section>

      <section className="mx-auto grid max-w-6xl gap-4 px-5 pb-12 sm:px-6 lg:grid-cols-3">
        {TIERS.map((t) => (
          <div key={t.name} data-reveal className={cn("flex flex-col rounded-2xl border bg-surface p-6", t.highlight ? "border-brand shadow-lg shadow-brand/10 ring-1 ring-brand/20" : "border-border")}>
            {t.highlight ? <div className="mb-3 inline-flex w-fit items-center rounded-full bg-brand/10 px-2.5 py-0.5 text-2xs font-semibold text-brand">Most popular</div> : null}
            <h2 className="text-[15px] font-semibold">{t.name}</h2>
            <p className="mt-1 text-[13px] text-muted">{t.blurb}</p>
            <div className="mt-4 flex items-baseline gap-1.5">
              <span className="font-mono text-3xl font-semibold tracking-tight">{t.price}</span>
              <span className="text-2xs text-faint">{t.unit}</span>
            </div>
            {t.cta.external ? (
              <a href={t.cta.href} target={t.cta.href.startsWith("mailto") ? undefined : "_blank"} rel="noreferrer" className={cn("mt-5 inline-flex h-10 items-center justify-center gap-1.5 rounded-xl px-4 text-sm font-semibold transition", t.highlight ? "bg-brand text-brand-fg hover:opacity-90" : "border border-border-strong text-fg hover:bg-surface-2")}>{t.name === "Self-host" ? <Github className="h-4 w-4" /> : null}{t.cta.label}</a>
            ) : (
              <Link to={t.cta.href} className={cn("mt-5 inline-flex h-10 items-center justify-center gap-1.5 rounded-xl px-4 text-sm font-semibold transition", t.highlight ? "bg-brand text-brand-fg hover:opacity-90" : "border border-border-strong text-fg hover:bg-surface-2")}>{t.cta.label} <ArrowRight className="h-4 w-4" /></Link>
            )}
            <ul className="mt-6 space-y-2.5 border-t border-border pt-5">
              {t.features.map((f) => (
                <li key={f} className="flex gap-2.5 text-[13px] text-muted"><Check className="mt-0.5 h-4 w-4 shrink-0 text-ok" />{f}</li>
              ))}
            </ul>
          </div>
        ))}
      </section>

      <section className="mx-auto max-w-5xl px-5 py-14 sm:px-6">
        <div className="grid gap-10 lg:grid-cols-[0.8fr_1.2fr] lg:gap-16">
          <div data-reveal className="h-max lg:sticky lg:top-24">
            <h2 className="text-2xl font-semibold tracking-tight sm:text-3xl">Pricing questions</h2>
            <p className="mt-3 text-[14px] leading-relaxed text-muted">Straight answers on plans and billing — no asterisks.</p>
          </div>
          <div data-reveal className="divide-y divide-border border-y border-border">
            {FAQ.map(([q, a]) => (
              <details key={q} className="group py-4">
                <summary className="flex cursor-pointer list-none items-center justify-between gap-4 text-[14.5px] font-medium">{q}<span className="text-lg leading-none text-muted transition group-open:rotate-45">+</span></summary>
                <p className="mt-2.5 text-[13.5px] leading-relaxed text-muted">{a}</p>
              </details>
            ))}
          </div>
        </div>
      </section>
    </MarketingShell>
  );
}
