import type { ReactNode } from "react";
import { Link } from "@remix-run/react";
import {
  Activity, AlertTriangle, ArrowRight, BellRing, Check, Github, GitBranch,
  Network, ScrollText, ShieldCheck, Terminal, Boxes, Zap, Lock, Server, Layers,
} from "lucide-react";
import { cn } from "~/lib/utils";

export const SITE = "https://backwork.dev";
export const REPO = "https://github.com/SirFitz/backwork";
export const TAGLINE = "Logs, metrics, and traces — self-hosted, multi-tenant, and honest about your data.";

/** Per-page SEO meta (title, description, canonical, OpenGraph, Twitter). */
export function seo({ title, description, path = "/", image = "/og.png" }: { title: string; description: string; path?: string; image?: string }) {
  const url = SITE + (path === "/" ? "" : path);
  const img = image.startsWith("http") ? image : SITE + image;
  return [
    { title },
    { name: "description", content: description },
    { tagName: "link", rel: "canonical", href: url },
    { property: "og:type", content: "website" },
    { property: "og:site_name", content: "backwork" },
    { property: "og:title", content: title },
    { property: "og:description", content: description },
    { property: "og:url", content: url },
    { property: "og:image", content: img },
    { property: "og:image:width", content: "1200" },
    { property: "og:image:height", content: "630" },
    { name: "twitter:card", content: "summary_large_image" },
    { name: "twitter:title", content: title },
    { name: "twitter:description", content: description },
    { name: "twitter:image", content: img },
    { name: "theme-color", content: "#ef5a6f" },
  ];
}

function JsonLd({ data }: { data: object }) {
  return <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(data) }} />;
}

const REVEAL_JS = `(function(){try{var io=new IntersectionObserver(function(es){es.forEach(function(e){if(e.isIntersecting){e.target.classList.add('is-in');io.unobserve(e.target);}})},{rootMargin:'0px 0px -8% 0px'});document.querySelectorAll('[data-reveal]').forEach(function(el){io.observe(el)});}catch(e){document.querySelectorAll('[data-reveal]').forEach(function(el){el.classList.add('is-in')})}})();`;

function Logo({ className }: { className?: string }) {
  return (
    <span className={cn("flex items-center gap-2", className)}>
      <span className="grid h-7 w-7 place-items-center rounded-md bg-brand font-mono text-sm font-bold text-brand-fg">b</span>
      <span className="text-[15px] font-semibold tracking-tight">backwork<span className="text-brand">.dev</span></span>
    </span>
  );
}

const navLink = "text-[13.5px] font-medium text-muted transition-colors hover:text-fg";

export function MarketingShell({ authed, active, children }: { authed?: boolean; active?: string; children: ReactNode }) {
  return (
    <div className="min-h-screen bg-bg text-fg">
      <header className="sticky top-0 z-40 border-b border-border/70 bg-bg/80 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-5 sm:px-6">
          <Link to="/" aria-label="backwork home"><Logo /></Link>
          <nav className="hidden items-center gap-7 md:flex">
            <Link to="/#features" className={cn(navLink, active === "features" && "text-fg")}>Features</Link>
            <Link to="/#how" className={navLink}>How it works</Link>
            <Link to="/pricing" className={cn(navLink, active === "pricing" && "text-fg")}>Pricing</Link>
            <Link to="/security" className={cn(navLink, active === "security" && "text-fg")}>Security</Link>
            <a href={REPO} target="_blank" rel="noreferrer" className={cn(navLink, "inline-flex items-center gap-1.5")}><Github className="h-4 w-4" /> GitHub</a>
          </nav>
          <div className="flex items-center gap-2.5">
            {authed ? (
              <Link to="/" className="inline-flex h-9 items-center rounded-lg bg-brand px-3.5 text-[13px] font-semibold text-brand-fg hover:opacity-90">Open dashboard</Link>
            ) : (
              <>
                <Link to="/login" className="hidden text-[13.5px] font-medium text-muted hover:text-fg sm:inline">Sign in</Link>
                <Link to="/register" className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-brand px-3.5 text-[13px] font-semibold text-brand-fg hover:opacity-90">Start free <ArrowRight className="h-3.5 w-3.5" /></Link>
              </>
            )}
          </div>
        </div>
      </header>
      <main>{children}</main>
      <footer className="border-t border-border/70">
        <div className="mx-auto grid max-w-6xl grid-cols-2 gap-8 px-5 py-12 sm:px-6 md:grid-cols-5">
          <div className="col-span-2 md:col-span-2">
            <Logo />
            <p className="mt-3 max-w-xs text-[13px] leading-relaxed text-muted">{TAGLINE}</p>
            <a href={REPO} target="_blank" rel="noreferrer" className="mt-4 inline-flex items-center gap-1.5 text-[13px] font-medium text-muted hover:text-fg"><Github className="h-4 w-4" /> Star on GitHub</a>
          </div>
          <FooterCol title="Product" links={[["Features", "/#features"], ["How it works", "/#how"], ["Pricing", "/pricing"], ["Security", "/security"]]} />
          <FooterCol title="Get started" links={[["Create account", "/register"], ["Sign in", "/login"], ["Install agent", "/security"]]} />
          <FooterCol title="Project" links={[["GitHub", REPO], ["Open standards", "/#stack"], ["Changelog", REPO + "/commits/main"]]} />
        </div>
        <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-2 border-t border-border/70 px-5 py-5 text-2xs text-faint sm:flex-row sm:px-6">
          <span>© {2026} backwork · self-hosted observability</span>
          <span className="font-mono">Loki · VictoriaMetrics · Jaeger · OpenTelemetry · Vector</span>
        </div>
      </footer>
      <script dangerouslySetInnerHTML={{ __html: REVEAL_JS }} />
    </div>
  );
}

function FooterCol({ title, links }: { title: string; links: [string, string][] }) {
  return (
    <div>
      <div className="text-2xs font-semibold uppercase tracking-wide text-faint">{title}</div>
      <ul className="mt-3 space-y-2">
        {links.map(([label, href]) => (
          <li key={label}>
            {href.startsWith("http") ? (
              <a href={href} target="_blank" rel="noreferrer" className="text-[13px] text-muted hover:text-fg">{label}</a>
            ) : (
              <Link to={href} className="text-[13px] text-muted hover:text-fg">{label}</Link>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

/* ---------- shared bits ---------- */
function Eyebrow({ children }: { children: ReactNode }) {
  return <div className="inline-flex items-center gap-1.5 rounded-full border border-border bg-surface px-3 py-1 text-2xs font-medium text-muted"><span className="h-1.5 w-1.5 rounded-full bg-brand" />{children}</div>;
}
function Section({ id, className, children }: { id?: string; className?: string; children: ReactNode }) {
  return <section id={id} className={cn("mx-auto max-w-6xl px-5 sm:px-6", className)}>{children}</section>;
}

/* ---------- hero visual: a live "backwork" dashboard mock ---------- */
function HeroVisual() {
  return (
    <div className="relative" data-reveal>
      <div className="pointer-events-none absolute -inset-8 -z-10 bg-[radial-gradient(60%_50%_at_70%_30%,oklch(var(--brand)/0.18),transparent)]" />
      <div className="overflow-hidden rounded-2xl border border-border-strong bg-surface shadow-2xl shadow-black/10 mk-float">
        {/* window chrome */}
        <div className="flex items-center gap-2 border-b border-border px-4 py-2.5">
          <span className="h-2.5 w-2.5 rounded-full bg-err/70" /><span className="h-2.5 w-2.5 rounded-full bg-warn/70" /><span className="h-2.5 w-2.5 rounded-full bg-ok/70" />
          <span className="ml-3 rounded bg-surface-2 px-2 py-0.5 font-mono text-2xs text-faint">backwork.dev/overview</span>
          <span className="ml-auto inline-flex items-center gap-1.5 rounded-md border border-border px-2 py-0.5 text-2xs text-muted">
            <span className="relative flex h-1.5 w-1.5"><span className="absolute inline-flex h-full w-full rounded-full bg-ok/60 mk-pulse-ring" /><span className="relative h-1.5 w-1.5 rounded-full bg-ok" /></span>Live
          </span>
        </div>
        <div className="grid grid-cols-[120px_1fr] divide-x divide-border">
          {/* mini sidebar */}
          <div className="hidden flex-col gap-1 p-3 sm:flex">
            {[["Overview", true], ["Logs", false], ["Metrics", false], ["Traces", false], ["Alerts", false]].map(([l, on]) => (
              <div key={l as string} className={cn("flex items-center gap-2 rounded px-2 py-1.5 text-2xs", on ? "bg-brand/10 text-brand" : "text-faint")}>
                <span className={cn("h-1.5 w-1.5 rounded-full", on ? "bg-brand" : "bg-faint/50")} />{l}
              </div>
            ))}
          </div>
          {/* body */}
          <div className="space-y-3 p-4">
            <div className="grid grid-cols-3 gap-3">
              {[["REQ/S", "1.2k", "text-fg"], ["ERRORS", "0.3%", "text-warn"], ["P95", "142ms", "text-fg"]].map(([k, v, t]) => (
                <div key={k} className="rounded-lg border border-border bg-bg px-3 py-2">
                  <div className="text-[9px] uppercase tracking-wide text-faint">{k}</div>
                  <div className={cn("font-mono text-sm font-semibold tabular-nums", t)}>{v}</div>
                </div>
              ))}
            </div>
            <div className="rounded-lg border border-border bg-bg p-3">
              <svg viewBox="0 0 320 96" className="h-24 w-full" preserveAspectRatio="none" aria-hidden>
                <defs>
                  <linearGradient id="hg" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="oklch(var(--brand))" stopOpacity="0.28" />
                    <stop offset="100%" stopColor="oklch(var(--brand))" stopOpacity="0" />
                  </linearGradient>
                </defs>
                {[24, 48, 72].map((y) => <line key={y} x1="0" y1={y} x2="320" y2={y} stroke="oklch(var(--border))" strokeWidth="1" />)}
                <path d="M0,70 C30,66 46,40 70,44 C96,48 108,20 134,26 C160,32 172,58 198,52 C226,46 240,16 268,22 C292,27 306,38 320,34 L320,96 L0,96 Z" fill="url(#hg)" />
                <path className="mk-draw" d="M0,70 C30,66 46,40 70,44 C96,48 108,20 134,26 C160,32 172,58 198,52 C226,46 240,16 268,22 C292,27 306,38 320,34" fill="none" stroke="oklch(var(--brand))" strokeWidth="2.2" strokeLinecap="round" />
              </svg>
            </div>
            <div className="space-y-1.5 font-mono text-[10px]">
              {[["12:04:21", "info", "GET /checkout 200 · 142ms"], ["12:04:21", "warn", "retry upstream payments (1/3)"], ["12:04:20", "err", "POST /charge 500 · timeout"]].map(([t, lvl, msg], i) => (
                <div key={i} className="flex items-center gap-2">
                  <span className="text-faint">{t}</span>
                  <span className={cn("w-7 font-semibold uppercase", lvl === "err" ? "text-err" : lvl === "warn" ? "text-warn" : "text-info")}>{lvl}</span>
                  <span className="truncate text-fg/80">{msg}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ---------- features ---------- */
const PILLARS = [
  { icon: ScrollText, name: "Logs", line: "Every line, searchable.", body: "Full-text and LogQL search across every container, with level, service and time filters and a live volume chart." },
  { icon: Activity, name: "Metrics", line: "Host to container to app.", body: "node-exporter and cAdvisor metrics plus RED rates derived from real traces — PromQL under the hood, no dashboards to wire." },
  { icon: GitBranch, name: "Traces", line: "Follow every request.", body: "OpenTelemetry-native distributed traces with a span waterfall and a service dependency map." },
  { icon: Network, name: "Requests", line: "RED, at a glance.", body: "A flat HTTP feed — method, route, status and latency — that jumps straight to the underlying trace." },
  { icon: AlertTriangle, name: "Incidents", line: "It tells you first.", body: "Crash, OOM, restart-loop and error-spike detection derived from real container state, metrics and logs." },
  { icon: BellRing, name: "Alerts", line: "Routed where you'll see them.", body: "Rules to Slack, Discord, webhook, email or SMS — with a no-data state so an outage never fakes “all clear.”" },
];

const DIFFS = [
  { icon: Server, title: "Own your data", body: "Self-hosted on your own box with one Docker command. Your telemetry never leaves your infrastructure — no per-GB bill, no third-party retention." },
  { icon: Layers, title: "Multi-tenant, SaaS-ready", body: "Organizations, teams, roles and per-project ingest tokens. Every tenant's logs, metrics and traces are isolated to the byte." },
  { icon: ShieldCheck, title: "Honest by design", body: "No demo data, no fake green. A data-source outage reads as “no data,” never “healthy” — so you trust the dashboard when it matters." },
  { icon: Terminal, title: "One command to ship", body: "curl | sh drops an agent on any host for logs and metrics. Point any OpenTelemetry SDK at one endpoint for traces. That's it." },
];

const STACK = ["OpenTelemetry", "Loki", "VictoriaMetrics", "Jaeger", "Prometheus", "Vector", "Grafana-compatible", "Docker"];

const FAQ = [
  ["Is backwork open source?", "Yes. The full stack lives in a public repo — clone it and run it yourself for free, forever."],
  ["Is it really self-hosted?", "Yes. backwork runs on your own host via Docker Compose, and your telemetry stays on your infrastructure."],
  ["Does it work with OpenTelemetry?", "Natively. Point any OTLP exporter at a single endpoint and your traces, requests and APM metrics appear automatically."],
  ["What's it built on?", "Battle-tested open standards — Loki for logs, VictoriaMetrics for metrics, Jaeger for traces and Vector for collection — unified behind one dashboard."],
  ["Can my whole team use it?", "Yes. Create organizations and teams, assign roles, and issue per-project ingest tokens that keep each tenant's data isolated."],
  ["How is it different from Grafana or Datadog?", "One integrated pane instead of a wall of dashboards, self-hosted economics instead of per-GB pricing, and states you can trust — it never shows green when your pipeline is down."],
];

export function MarketingLanding({ authed }: { authed?: boolean }) {
  return (
    <MarketingShell authed={authed} active="features">
      <JsonLd data={{
        "@context": "https://schema.org", "@type": "SoftwareApplication", name: "backwork",
        applicationCategory: "DeveloperApplication", operatingSystem: "Docker / Linux",
        description: TAGLINE, url: SITE, offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
      }} />
      <JsonLd data={{ "@context": "https://schema.org", "@type": "FAQPage", mainEntity: FAQ.map(([q, a]) => ({ "@type": "Question", name: q, acceptedAnswer: { "@type": "Answer", text: a } })) }} />

      {/* hero */}
      <Section className="grid items-center gap-12 pt-16 pb-14 lg:grid-cols-2 lg:pt-24 lg:pb-20">
        <div data-reveal>
          <Eyebrow>Self-hosted observability</Eyebrow>
          <h1 className="mt-5 text-4xl font-semibold leading-[1.07] tracking-tight sm:text-5xl">
            Your logs, metrics, and traces — in one <span className="text-brand">honest</span> pane.
          </h1>
          <p className="mt-5 max-w-xl text-[15px] leading-relaxed text-muted sm:text-base">
            backwork unifies logs, metrics, distributed traces, requests, incidents and alerts into a single self-hosted dashboard. Multi-tenant, OpenTelemetry-native, and engineered to never show you green when your pipeline is down.
          </p>
          <div className="mt-7 flex flex-wrap items-center gap-3">
            <Link to="/register" className="inline-flex h-11 items-center gap-2 rounded-xl bg-brand px-5 text-sm font-semibold text-brand-fg shadow-sm transition hover:opacity-90">Start free <ArrowRight className="h-4 w-4" /></Link>
            <a href="#how" className="inline-flex h-11 items-center gap-2 rounded-xl border border-border-strong px-5 text-sm font-semibold text-fg transition hover:bg-surface-2">See how it works</a>
          </div>
          <p className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-1 text-2xs text-faint">
            <span className="inline-flex items-center gap-1.5"><Check className="h-3.5 w-3.5 text-ok" /> Open source</span>
            <span className="inline-flex items-center gap-1.5"><Check className="h-3.5 w-3.5 text-ok" /> One Docker command</span>
            <span className="inline-flex items-center gap-1.5"><Check className="h-3.5 w-3.5 text-ok" /> No credit card</span>
          </p>
        </div>
        <HeroVisual />
      </Section>

      {/* trust / stack marquee */}
      <Section id="stack" className="pb-6">
        <div className="rounded-2xl border border-border bg-surface/60 px-5 py-5">
          <p className="text-center text-2xs font-medium uppercase tracking-wide text-faint">Built on the open standards you already trust</p>
          <div className="mt-4 flex flex-wrap items-center justify-center gap-x-8 gap-y-3 font-mono text-[13px] text-muted">
            {STACK.map((s) => <span key={s} className="whitespace-nowrap">{s}</span>)}
          </div>
        </div>
      </Section>

      {/* problem → solution */}
      <Section className="py-20 text-center" >
        <div data-reveal className="mx-auto max-w-3xl">
          <Eyebrow>The problem</Eyebrow>
          <h2 className="mt-5 text-3xl font-semibold tracking-tight sm:text-4xl">Observability shouldn't cost more than the thing you're observing.</h2>
          <p className="mt-5 text-[15px] leading-relaxed text-muted sm:text-base">
            Per-GB pricing punishes you for having traffic. Five separate tools never agree. And too many dashboards quietly show green when the data behind them stopped flowing. backwork is the opposite: one stack you run yourself, one pane that tells the truth.
          </p>
        </div>
      </Section>

      {/* features grid */}
      <Section id="features" className="py-8">
        <div data-reveal className="mb-10 text-center">
          <Eyebrow>One tool, the whole picture</Eyebrow>
          <h2 className="mt-5 text-3xl font-semibold tracking-tight sm:text-4xl">Everything you need to watch a system.</h2>
          <p className="mx-auto mt-4 max-w-2xl text-[15px] text-muted">Logs, metrics and traces share one timeline, one search, and one set of alerts — no tab-juggling.</p>
        </div>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {PILLARS.map((p) => (
            <div key={p.name} data-reveal className="group rounded-2xl border border-border bg-surface p-5 transition hover:border-border-strong hover:shadow-sm">
              <span className="grid h-10 w-10 place-items-center rounded-xl bg-brand/10 text-brand transition group-hover:scale-105"><p.icon className="h-5 w-5" /></span>
              <h3 className="mt-4 text-[15px] font-semibold">{p.name} <span className="font-normal text-muted">— {p.line}</span></h3>
              <p className="mt-1.5 text-[13px] leading-relaxed text-muted">{p.body}</p>
            </div>
          ))}
        </div>
      </Section>

      {/* differentiators */}
      <Section className="py-20">
        <div className="grid gap-4 md:grid-cols-2">
          {DIFFS.map((d) => (
            <div key={d.title} data-reveal className="flex gap-4 rounded-2xl border border-border bg-surface p-6">
              <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-brand/10 text-brand"><d.icon className="h-5 w-5" /></span>
              <div>
                <h3 className="text-base font-semibold">{d.title}</h3>
                <p className="mt-1.5 text-[13.5px] leading-relaxed text-muted">{d.body}</p>
              </div>
            </div>
          ))}
        </div>
      </Section>

      {/* how it works */}
      <Section id="how" className="py-20">
        <div data-reveal className="mb-10 text-center">
          <Eyebrow>How it works</Eyebrow>
          <h2 className="mt-5 text-3xl font-semibold tracking-tight sm:text-4xl">Live in three steps.</h2>
        </div>
        <div className="grid gap-4 md:grid-cols-3">
          <Step n="1" title="Create a project" body="Spin up an organization and get a per-project ingest token, scoped to your tenant.">
            <code className="text-brand">backwork.dev/projects</code> → <span className="text-fg">New project</span>
          </Step>
          <Step n="2" title="Ship your telemetry" body="One command for logs + metrics on any host. One env var for OpenTelemetry traces.">
            curl -fsSL backwork.dev/install.sh | sh
          </Step>
          <Step n="3" title="Watch it live" body="A unified dashboard that auto-refreshes, detects incidents, and routes alerts where you'll see them.">
            OTEL_EXPORTER_OTLP_ENDPOINT=<span className="text-brand">backwork.dev/otlp</span>
          </Step>
        </div>
      </Section>

      {/* honest-by-design band */}
      <Section className="py-8">
        <div data-reveal className="overflow-hidden rounded-3xl border border-border-strong bg-gradient-to-br from-brand/10 via-surface to-surface px-6 py-12 text-center sm:px-12">
          <ShieldCheck className="mx-auto h-8 w-8 text-brand" />
          <h2 className="mx-auto mt-4 max-w-2xl text-2xl font-semibold tracking-tight sm:text-3xl">It never shows you green when your pipeline is down.</h2>
          <p className="mx-auto mt-4 max-w-2xl text-[15px] leading-relaxed text-muted">
            Most tools coerce a missing metric to zero and paint it healthy. backwork distinguishes <span className="font-medium text-fg">no data</span> from <span className="font-medium text-fg">all clear</span> — across overview, incidents and alerts — so an outage in the telemetry path is visible, not hidden.
          </p>
        </div>
      </Section>

      {/* pricing teaser */}
      <Section className="py-20 text-center">
        <div data-reveal>
          <Eyebrow>Pricing</Eyebrow>
          <h2 className="mt-5 text-3xl font-semibold tracking-tight sm:text-4xl">Free to self-host. Pay only for convenience.</h2>
          <p className="mx-auto mt-4 max-w-xl text-[15px] text-muted">Run the whole thing yourself at no cost, or let us host and scale it for you.</p>
          <div className="mt-7 flex justify-center">
            <Link to="/pricing" className="inline-flex h-11 items-center gap-2 rounded-xl border border-border-strong px-5 text-sm font-semibold text-fg transition hover:bg-surface-2">See pricing <ArrowRight className="h-4 w-4" /></Link>
          </div>
        </div>
      </Section>

      {/* FAQ */}
      <Section className="py-12">
        <div data-reveal className="mb-8 text-center">
          <Eyebrow>FAQ</Eyebrow>
          <h2 className="mt-5 text-3xl font-semibold tracking-tight sm:text-4xl">Questions, answered.</h2>
        </div>
        <div className="mx-auto max-w-3xl divide-y divide-border rounded-2xl border border-border bg-surface">
          {FAQ.map(([q, a]) => (
            <details key={q} className="group px-5 py-4">
              <summary className="flex cursor-pointer list-none items-center justify-between text-[14.5px] font-medium">
                {q}
                <span className="ml-4 text-muted transition group-open:rotate-45">+</span>
              </summary>
              <p className="mt-2 text-[13.5px] leading-relaxed text-muted">{a}</p>
            </details>
          ))}
        </div>
      </Section>

      {/* final CTA */}
      <Section className="py-20">
        <div data-reveal className="rounded-3xl border border-border-strong bg-surface px-6 py-14 text-center sm:px-12">
          <h2 className="text-3xl font-semibold tracking-tight sm:text-4xl">Stop renting your observability.</h2>
          <p className="mx-auto mt-4 max-w-xl text-[15px] text-muted">Deploy backwork on your own host in minutes and own your telemetry end to end.</p>
          <div className="mt-7 flex flex-wrap items-center justify-center gap-3">
            <Link to="/register" className="inline-flex h-11 items-center gap-2 rounded-xl bg-brand px-5 text-sm font-semibold text-brand-fg hover:opacity-90">Start free <ArrowRight className="h-4 w-4" /></Link>
            <a href={REPO} target="_blank" rel="noreferrer" className="inline-flex h-11 items-center gap-2 rounded-xl border border-border-strong px-5 text-sm font-semibold text-fg hover:bg-surface-2"><Github className="h-4 w-4" /> Star on GitHub</a>
          </div>
        </div>
      </Section>
    </MarketingShell>
  );
}

function Step({ n, title, body, children }: { n: string; title: string; body: string; children: ReactNode }) {
  return (
    <div data-reveal className="rounded-2xl border border-border bg-surface p-6">
      <span className="grid h-8 w-8 place-items-center rounded-lg bg-brand font-mono text-sm font-bold text-brand-fg">{n}</span>
      <h3 className="mt-4 text-base font-semibold">{title}</h3>
      <p className="mt-1.5 text-[13.5px] leading-relaxed text-muted">{body}</p>
      <pre className="mt-4 overflow-x-auto scroll-thin rounded-lg border border-border bg-bg px-3 py-2.5 font-mono text-[11px] leading-relaxed text-fg/90">{children}</pre>
    </div>
  );
}
