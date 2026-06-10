import type { LoaderFunctionArgs, MetaFunction } from "@remix-run/node";
import { json } from "@remix-run/node";
import { Link, useLoaderData } from "@remix-run/react";
import { ArrowRight, Server, Layers, Lock, KeyRound, ShieldAlert, ShieldCheck, Eye } from "lucide-react";
import { getUser } from "~/lib/auth/context.server";
import { MarketingShell, seo } from "~/components/marketing";

export const meta: MetaFunction = () =>
  seo({
    title: "Security & data ownership — backwork",
    description: "Self-hosted by default, byte-level per-tenant isolation, encryption at rest, server-side session revocation, and dashboards that never fake “healthy.”",
    path: "/security",
  });

export async function loader({ request }: LoaderFunctionArgs) {
  return json({ authed: !!(await getUser(request)) });
}

const PRINCIPLES = [
  { icon: Server, title: "Self-hosted by default", body: "backwork runs on your own infrastructure. Logs, metrics and traces are stored on your disk and never traverse a third party — the strongest data-residency guarantee there is." },
  { icon: Layers, title: "Per-tenant isolation, to the byte", body: "Every organization's data is scoped by an enforced org_id: injected into log stream labels, metric series and trace spans at ingest, and filtered server-side on every query. A tenant can never read another's telemetry." },
  { icon: Lock, title: "Encryption & hashing at rest", body: "Alert-channel secrets are sealed with AES-256-GCM (HKDF-derived keys). Ingest tokens are stored only as SHA-256 hashes. Passwords use argon2id with a server-side pepper." },
  { icon: KeyRound, title: "Hardened sessions", body: "Signed, HttpOnly, Secure cookies with server-side revocation via a token version — logging out or changing a password invalidates captured cookies everywhere. Per-IP and per-account rate limiting throttles brute force." },
  { icon: ShieldAlert, title: "Safe by construction", body: "Same-origin (CSRF) checks on every state-changing action, SSRF guards that block alert webhooks from reaching internal or metadata endpoints, and path-only redirects that can't be hijacked." },
  { icon: Eye, title: "Honest by design", body: "A missing or failed data source reads as “no data,” never “healthy.” Outages in the telemetry path are surfaced, not masked — so the dashboard is trustworthy precisely when you need it most." },
];

export default function Security() {
  const { authed } = useLoaderData<typeof loader>();
  return (
    <MarketingShell authed={authed} active="security">
      <section className="relative mx-auto max-w-6xl px-5 pt-16 pb-12 text-center sm:px-6 lg:pt-24">
        <div className="pointer-events-none absolute left-1/2 top-8 -z-10 h-64 w-64 -translate-x-1/2 rounded-full bg-[radial-gradient(closest-side,oklch(var(--brand)/0.16),transparent)]" aria-hidden />
        <div data-reveal>
          <div className="relative mx-auto mb-6 grid h-14 w-14 place-items-center rounded-2xl border border-border-strong bg-surface text-brand shadow-sm">
            <span className="absolute inset-0 rounded-2xl ring-1 ring-brand/20" />
            <ShieldCheck className="h-7 w-7" />
          </div>
          <div className="inline-flex items-center gap-1.5 rounded-full border border-border bg-surface px-3 py-1 text-2xs font-medium text-muted"><span className="h-1.5 w-1.5 rounded-full bg-brand" />Security</div>
          <h1 className="mx-auto mt-5 max-w-2xl text-4xl font-semibold leading-tight tracking-tight sm:text-5xl">Your telemetry, under your control.</h1>
          <p className="mx-auto mt-5 max-w-xl text-[15px] leading-relaxed text-muted sm:text-base">Observability data is some of the most sensitive you hold — it describes exactly how your systems work. backwork is built so it stays yours, isolated, and honest.</p>
        </div>
      </section>

      {/* principles — spec-sheet (top-ruled, not boxed cards) */}
      <section className="mx-auto max-w-5xl px-5 pb-16 sm:px-6">
        <div className="grid gap-x-12 gap-y-9 sm:grid-cols-2">
          {PRINCIPLES.map((p) => (
            <div key={p.title} data-reveal className="border-t border-border pt-5">
              <div className="flex items-center gap-2.5">
                <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-brand/10 text-brand"><p.icon className="h-4 w-4" /></span>
                <h2 className="text-[15px] font-semibold">{p.title}</h2>
              </div>
              <p className="mt-2.5 text-[13.5px] leading-relaxed text-muted">{p.body}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="mx-auto max-w-3xl px-5 pb-20 sm:px-6">
        <div data-reveal className="rounded-2xl border border-border-strong bg-surface p-6 text-center">
          <h2 className="text-lg font-semibold">Found something?</h2>
          <p className="mx-auto mt-2 max-w-md text-[13.5px] leading-relaxed text-muted">We take security reports seriously. Responsible disclosures are reviewed promptly — please don't open a public issue for vulnerabilities.</p>
          <a href="mailto:security@backwork.dev?subject=Security%20report" className="mt-4 inline-flex h-10 items-center gap-2 rounded-xl bg-brand px-4 text-sm font-semibold text-brand-fg hover:opacity-90">Report a vulnerability <ArrowRight className="h-4 w-4" /></a>
        </div>
        <p className="mt-8 text-center text-[13px] text-muted">Ready to own your observability? <Link to="/register" className="font-medium text-brand hover:underline">Start free →</Link></p>
      </section>
    </MarketingShell>
  );
}
