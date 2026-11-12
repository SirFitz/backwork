import { Link } from "@remix-run/react";
import { ArrowRight, Bell, Bug, CircleCheck, CornerDownRight, Database, FolderKanban, OctagonX, ScrollText, Search, ShieldCheck } from "lucide-react";
import { cn } from "~/lib/utils";
import { CtaBand, Eyebrow, H2, JsonLd, Lede, MarketingShell, NavKey, SITE, Ticks, Wrap, btnPrimary, btnSecondary } from "~/components/marketing";
import { AGENT, CodeTabs, INSTALL, Runtime } from "~/components/site/code-tabs";
import { RequestPreview, RequestPreviewCompact } from "~/components/site/request-preview";

const SVC = {
  api: "oklch(0.62 0.12 240)",
  risk: "oklch(0.64 0.1 195)",
  pay: "oklch(0.6 0.15 290)",
  worker: "oklch(0.6 0.13 335)",
} as const;

function Window({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={cn("overflow-hidden rounded-t-2xl border border-b-0 border-border-strong bg-bg shadow-[0_30px_80px_-30px_oklch(0.2_0.02_265/0.35)]", className)}>
      <div className="flex h-[38px] items-center gap-[7px] border-b border-border bg-surface px-3.5">
        <i className="h-2.5 w-2.5 rounded-full bg-border-strong" /><i className="h-2.5 w-2.5 rounded-full bg-border-strong" /><i className="h-2.5 w-2.5 rounded-full bg-border-strong" />
      </div>
      <div className="relative max-h-[640px] overflow-hidden after:pointer-events-none after:absolute after:inset-x-0 after:bottom-0 after:h-28 after:bg-gradient-to-b after:from-transparent after:to-bg">
        {children}
      </div>
    </div>
  );
}

function Hero() {
  return (
    <section className="overflow-hidden bg-[radial-gradient(900px_420px_at_72%_6%,oklch(var(--brand)/0.05),transparent_70%)]">
      <Wrap className="pt-14 sm:pt-[88px]">
        <div className="max-w-[760px]">
          <Eyebrow>Request tracing from the logs you already write</Eyebrow>
          <h1 className="mt-[18px] text-balance text-[40px] font-semibold leading-[1.02] tracking-[-0.04em] sm:text-[64px]">Follow any request, from one ID.</h1>
          <p className="mt-5 max-w-[56ch] text-[16px] leading-relaxed text-muted sm:text-[18px]">
            Paste the reference from a support ticket, an order number or a trace ID. backwork shows every service the
            request passed through, how long each step took, and exactly where it stopped.
          </p>
          <div className="mt-8 flex flex-col gap-3 sm:flex-row">
            <Link to="/register" className={btnPrimary}>Start free <ArrowRight className="h-4 w-4" /></Link>
            <Link to="/docs" className={btnSecondary}>Read the docs</Link>
          </div>
          <p className="mt-3.5 text-[13px] text-faint">Free plan · No card needed · Set up in a minute</p>
        </div>

        <div className="relative z-10 mx-auto mt-14 max-w-[640px] translate-y-[38px] sm:mt-16">
          <div className="flex h-14 items-center gap-2.5 rounded-xl border border-brand bg-bg px-4 shadow-[0_0_0_4px_oklch(var(--brand)/0.14),0_18px_40px_-16px_oklch(0.2_0.01_60/0.3)]">
            <Search className="h-[17px] w-[17px] shrink-0 text-muted" />
            <span className="font-mono text-[16px]">PO-88213</span>
            <i className="-ml-1 h-5 w-[1.5px] bg-fg" aria-hidden />
            <span className="ml-auto hidden truncate text-[12.5px] text-faint sm:inline">payout_id · linked to trace 9c2f41d0…</span>
            <span className="rounded border border-border px-1.5 font-mono text-[10.5px] text-faint">⏎</span>
          </div>
        </div>
        <div className="-mx-4 sm:mx-0 lg:-mx-10">
          <Window className="hidden md:block"><RequestPreview /></Window>
          <Window className="md:hidden"><RequestPreviewCompact /></Window>
        </div>
      </Wrap>
    </section>
  );
}

const WORKS_WITH = ["Node", "Bun", "Elixir", "Erlang", "Express", "Fastify", "Hono", "Remix", "Phoenix", "BullMQ", "Oban", "Ecto", "pino", "node-postgres", "ioredis"];

function WorksWith() {
  return (
    <section className="border-y border-border bg-surface">
      <Wrap className="flex flex-col gap-3 py-5 sm:flex-row sm:items-center sm:gap-7">
        <span className="whitespace-nowrap font-mono text-[12px] text-faint">Works with</span>
        <div className="flex flex-wrap gap-x-6 gap-y-1.5 text-[14px] font-medium text-muted">{WORKS_WITH.map((n) => <span key={n}>{n}</span>)}</div>
      </Wrap>
    </section>
  );
}

function TreeRow({ depth, color, children }: { depth: number; color: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-1.5 whitespace-nowrap py-[5px]" style={{ paddingLeft: depth * 18 }}>
      {depth > 0 && <CornerDownRight className="-ml-4 h-3 w-3 shrink-0 text-border-strong" />}
      <i className="h-2 w-2 shrink-0 rounded-full" style={{ background: color }} />
      <span className="truncate">{children}</span>
    </div>
  );
}

function TimeRow({ label, color, left, width, took, out, store }: { label: string; color: string; left: number; width: number; took: string; out?: boolean; store?: boolean }) {
  return (
    <div className="grid grid-cols-[112px_1fr_52px] items-center gap-2.5 py-1.5">
      <span className="truncate font-mono text-[11px] text-muted">{label}</span>
      <span className="relative h-3 rounded bg-fg/5">
        <span className={cn("absolute top-0 h-3 min-w-[3px] rounded", store ? "bg-muted/50" : out ? "" : "")}
          style={store ? { left: `${left}%`, width: `${width}%` } : out
            ? { left: `${left}%`, width: `${width}%`, background: `color-mix(in oklch, ${color} 22%, transparent)`, boxShadow: `inset 0 0 0 1.5px ${color}` }
            : { left: `${left}%`, width: `${width}%`, background: color }} />
      </span>
      <span className="text-right font-mono text-[11px]">{took}</span>
    </div>
  );
}

function ThreeAnswers() {
  const card = "flex flex-col rounded-2xl border border-border bg-surface p-5";
  const art = "h-[200px] overflow-hidden rounded-[10px] border border-border bg-bg p-4 text-[12.5px]";
  return (
    <section id="request-view" className="scroll-mt-20 border-b border-border">
      <Wrap className="py-20 sm:py-28">
        <div className="mb-12 max-w-[720px]">
          <Eyebrow>The request view</Eyebrow>
          <H2>Three answers on one page.</H2>
          <Lede>Whoever is looking (support, an engineer on call, the person who owns the product) gets the same page, in words they can read.</Lede>
        </div>
        <div className="grid gap-5 lg:grid-cols-3">
          <article className={card}>
            <div className={art}>
              <TreeRow depth={0} color={SVC.api}><b>commerce-api</b> <span className="font-mono text-[12px] text-muted">POST /orders</span></TreeRow>
              <TreeRow depth={1} color={SVC.risk}><b>commerce-risk</b> <span className="font-mono text-[12px] text-muted">/assess</span></TreeRow>
              <TreeRow depth={1} color={SVC.pay}><b>commerce-payments</b> <span className="font-mono text-[12px] text-muted">/charges</span></TreeRow>
              <TreeRow depth={2} color={SVC.pay}><Database className="mr-1 inline h-3 w-3 text-faint" /><span className="font-mono text-[12px] text-muted">payments-db</span></TreeRow>
              <TreeRow depth={1} color={SVC.worker}><b>commerce-worker</b> <span className="font-mono text-[12px] text-muted">Receipts.SendEmail</span></TreeRow>
            </div>
            <h3 className="mt-5 text-[18px] font-semibold tracking-tight">Where did it go?</h3>
            <p className="mt-2 text-[14.5px] text-muted">Every service, database, cache and background job the request touched, in the order they happened.</p>
          </article>
          <article className={card}>
            <div className={art}>
              <TimeRow label="POST /orders" color={SVC.api} left={0} width={100} took="61.2 ms" />
              <TimeRow label="risk /assess" color={SVC.risk} left={5} width={13} took="7.9 ms" />
              <TimeRow label="payments /charges" color={SVC.pay} left={23} width={24} took="14.8 ms" />
              <TimeRow label="acquirer.example" color={SVC.pay} left={26} width={18} took="11.2 ms" out />
              <TimeRow label="orders-db insert" color={SVC.api} left={78} width={6} took="3.8 ms" store />
            </div>
            <h3 className="mt-5 text-[18px] font-semibold tracking-tight">How long did each step take?</h3>
            <p className="mt-2 text-[14.5px] text-muted">Time in each service, and the share of it spent waiting on the database, the cache or another company's API.</p>
          </article>
          <article className={card}>
            <div className={art}>
              <div className="flex gap-2 text-[12.5px] leading-snug"><OctagonX className="mt-px h-4 w-4 shrink-0 text-err" /><div><b>Stopped in commerce-payments.</b> The call to <span className="font-mono">bank-gw.internal</span> never finished.</div></div>
              <div className="mt-3 rounded-lg border border-border px-2.5 py-1.5 font-mono text-[11px] leading-[1.75]">
                {[["02:14:07.412", "info", "transfer submitted"], ["02:14:13.418", "warn", "gateway slow, 6s"], ["02:14:19.870", "warn", "gateway slow, 12s"]].map(([t, l, m]) => (
                  <div key={t} className="grid grid-cols-[82px_32px_1fr] gap-2 whitespace-nowrap"><span className="text-faint">{t}</span><span className={l === "warn" ? "text-warn" : "text-muted"}>{l}</span><span className="truncate">{m}</span></div>
                ))}
              </div>
            </div>
            <h3 className="mt-5 text-[18px] font-semibold tracking-tight">Where did it stop?</h3>
            <p className="mt-2 text-[14.5px] text-muted">When a request never finishes, backwork names the last step that started and shows what that service logged.</p>
          </article>
        </div>
        <div className="mt-7 flex flex-wrap items-center gap-2.5">
          <span className="mr-1.5 text-[13.5px] text-muted">Find it by</span>
          {[["request ID", "F8Zx2o1yQk0AAAEB"], ["trace ID", "6503f5f1…65ad72fa"], ["order_id", "7731"], ["provider reference", "A91K20"]].map(([k, v]) => (
            <span key={k} className="inline-flex h-[34px] items-center gap-2 rounded-full border border-border bg-surface px-3 text-[12.5px]"><em className="not-italic text-faint">{k}</em><span className="font-mono">{v}</span></span>
          ))}
        </div>
      </Wrap>
    </section>
  );
}

const ROUTES = [
  { route: "POST /orders", svc: "commerce-api", typical: "58 ms", slow: "212 ms", db: 34, trend: [52, 55, 61, 58, 60, 57, 58], bad: false },
  { route: "POST /charges", svc: "commerce-payments", typical: "14 ms", slow: "96 ms", db: 22, trend: [15, 14, 16, 13, 14, 15, 14], bad: false },
  { route: "POST /payouts/:id/release", svc: "commerce-api", typical: "1.9 s", slow: "30.0 s", db: 3, trend: [1.1, 1.2, 1.3, 1.4, 1.9, 2.4, 3.1], bad: true },
  { route: "GET /merchants/:id", svc: "commerce-api", typical: "9 ms", slow: "41 ms", db: 61, trend: [9, 10, 9, 9, 8, 9, 9], bad: false },
];

function Spark({ values, bad }: { values: number[]; bad: boolean }) {
  const w = 64, h = 20, lo = Math.min(...values), span = Math.max(...values) - lo || 1, step = w / (values.length - 1);
  const pts = values.map((v, i) => `${(i * step).toFixed(1)},${(h - 2 - ((v - lo) / span) * (h - 4)).toFixed(1)}`).join(" ");
  return <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden><polyline points={pts} fill="none" stroke={bad ? "oklch(var(--err))" : "oklch(var(--muted))"} strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" /></svg>;
}

function Performance() {
  return (
    <section id="performance" className="scroll-mt-20 border-b border-border bg-surface">
      <Wrap className="grid items-start gap-12 py-20 sm:py-28 lg:grid-cols-[0.8fr_1.2fr] lg:gap-16">
        <div className="pt-2">
          <Eyebrow>Performance</Eyebrow>
          <H2>See what got slower, before anyone writes in.</H2>
          <Lede>Every finished step becomes a timing. backwork keeps the typical and the slow case for each route and service, how much of it was database or cache time, and how that changed this week.</Lede>
          <Ticks items={["Per route, per service, per database", "One click from a slow route to a real slow request", "Kept with your plan's request paths"]} />
        </div>
        <div className="overflow-hidden rounded-xl border border-border bg-bg">
          <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3.5">
            <div><h3 className="text-[15px] font-semibold">Routes</h3><p className="text-[11px] text-faint">Last 7 days · all services</p></div>
            <div className="flex items-center gap-0.5 rounded-lg border border-border p-[3px] text-[12px] font-medium text-muted">
              <b className="rounded-[5px] bg-surface-2 px-2.5 py-1 font-medium text-fg">7 d</b><span className="px-2.5 py-1">24 h</span><span className="px-2.5 py-1">1 h</span>
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] border-collapse text-[13px]">
              <thead>
                <tr className="text-left text-[11px] font-medium uppercase tracking-wide text-faint">
                  <th className="border-b border-border px-4 py-2.5 font-medium">Route</th><th className="border-b border-border px-3 py-2.5 text-right font-medium">Typical</th>
                  <th className="border-b border-border px-3 py-2.5 text-right font-medium">Slow (p95)</th><th className="border-b border-border px-3 py-2.5 font-medium">Database</th>
                  <th className="border-b border-border px-3 py-2.5 font-medium">Trend</th>
                </tr>
              </thead>
              <tbody>
                {ROUTES.map((r) => (
                  <tr key={r.route} className="border-b border-border last:border-b-0">
                    <td className="px-4 py-2.5"><span className="font-mono">{r.route}</span><div className="text-[11px] text-faint">{r.svc}</div></td>
                    <td className="px-3 py-2.5 text-right font-mono">{r.typical}</td>
                    <td className={cn("px-3 py-2.5 text-right font-mono", r.bad && "text-err")}>{r.slow}</td>
                    <td className="whitespace-nowrap px-3 py-2.5"><span className="inline-block h-1.5 w-12 overflow-hidden rounded-full bg-fg/10 align-middle"><i className="block h-full bg-muted" style={{ width: `${r.db}%` }} /></span><span className="ml-1.5 font-mono text-[11px] text-faint">{r.db}%</span></td>
                    <td className="px-3 py-2.5"><Spark values={r.trend} bad={r.bad} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </Wrap>
    </section>
  );
}

function Setup() {
  return (
    <section id="setup" className="scroll-mt-20 border-b border-border">
      <Wrap className="grid items-start gap-12 py-20 sm:py-28 lg:grid-cols-[0.8fr_1.2fr] lg:gap-16">
        <div className="pt-2">
          <Eyebrow>Setup</Eyebrow>
          <H2>One package. One line.</H2>
          <Lede>Correlator carries one ID through every call, job and message, and writes it into your log lines. backwork reads those lines. Your service needs no backwork token, endpoint or SDK.</Lede>
          <Ticks items={["Finds your framework, job queue and database client by itself", "Works next to Sentry, AppSignal or OpenTelemetry", "Request bodies and parameters are never read"]} />
        </div>
        <div className="min-w-0">
          <CodeTabs
            samples={Object.fromEntries(Object.values(Runtime).map((r) => [r, [...INSTALL[r], { kind: "plain", text: "" }, ...AGENT]]))}
            footer={<span className="flex items-center gap-2 opacity-80"><CircleCheck className="h-4 w-4 text-ok" />First requests appear within about 30 seconds.</span>}
          />
        </div>
      </Wrap>
    </section>
  );
}

const SWITCHES = [
  { title: "Log lines", detail: "Everything your services write", on: true },
  { title: "Request paths", detail: "Hop records from Correlator", on: true },
  { title: "Named fields", detail: "Values a developer chose to attach", on: false },
  { title: "Linked IDs", detail: "Order numbers and provider references", on: true },
];

function Switch({ on }: { on: boolean }) {
  return <span aria-hidden className={cn("inline-flex h-[18px] w-[30px] rounded-full p-0.5", on ? "justify-end bg-fg" : "bg-border-strong")}><i className="h-3.5 w-3.5 rounded-full bg-bg" /></span>;
}

function Control() {
  return (
    <section className="border-b border-border bg-surface">
      <Wrap className="grid items-start gap-12 py-20 sm:py-28 lg:grid-cols-[0.8fr_1.2fr] lg:gap-16">
        <div className="pt-2">
          <Eyebrow>Your data, your switches</Eyebrow>
          <H2>You decide what backwork keeps.</H2>
          <Lede>Everything starts on. Anyone who runs the organisation can switch a kind of data off for a project or a single service, without waiting for a developer. Off anywhere means off.</Lede>
          <Ticks items={["Sensitive data is removed on your server, before anything is sent", "Add your own patterns, per organisation", "Each organisation sees only its own data"]} />
        </div>
        <div className="grid gap-4">
          <div className="rounded-xl border border-border bg-bg">
            <div className="border-b border-border px-[18px] py-3.5"><h3 className="text-[15px] font-semibold">checkout</h3><p className="text-[11px] text-faint">What backwork collects for this project</p></div>
            <div className="px-[18px] py-1">
              {SWITCHES.map((s) => (
                <div key={s.title} className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-3 border-b border-border py-2.5 last:border-b-0">
                  <div><b className="block text-[13px] font-medium">{s.title}</b><span className="block text-[12px] text-muted">{s.detail}</span></div>
                  <em className={cn("text-[11.5px] not-italic", s.on ? "text-muted" : "text-faint")}>{s.on ? "On" : "Off"}</em><Switch on={s.on} />
                </div>
              ))}
            </div>
          </div>
          <div className="rounded-xl border border-border bg-bg">
            <div className="flex items-start justify-between border-b border-border px-[18px] py-3.5">
              <div><h3 className="text-[15px] font-semibold">Sensitive-data filter</h3><p className="text-[11px] text-faint">Removed before anything is sent or saved</p></div>
              <span className="rounded bg-ok/10 px-1.5 py-px text-[11px] font-medium text-ok ring-1 ring-inset ring-ok/25">On</span>
            </div>
            <div className="flex flex-wrap gap-2 px-[18px] pb-1.5 pt-4">
              {["Card numbers", "Email addresses", "Phone numbers", "Passwords", "API keys and tokens", "member_no=\\d+"].map((t) => (
                <span key={t} className={cn("inline-flex h-7 items-center rounded-md border border-border px-2.5 text-[12.5px]", t.includes("\\") && "font-mono")}>{t}</span>
              ))}
            </div>
            <div className="mx-[18px] mb-[18px] mt-2.5 overflow-x-auto rounded-lg border border-border px-3 py-2.5 font-mono text-[12px] leading-[1.8]">
              <div className="whitespace-nowrap"><span className="text-faint">before</span> charge failed card=4111 1111 1111 1111 email=k.brown@…</div>
              <div className="whitespace-nowrap"><span className="text-faint">saved&nbsp;</span> charge failed card=[filtered] email=[filtered]</div>
            </div>
          </div>
        </div>
      </Wrap>
    </section>
  );
}

const ALSO = [
  { icon: ScrollText, title: "Log search", body: "Search every line from every service, by text, level, service and time." },
  { icon: Bug, title: "Errors", body: "Errors grouped by cause, each one linked to the request it happened in." },
  { icon: Bell, title: "Needs attention and alerts", body: "Services failing or slower than usual, and requests that stopped, on the Overview and sent to email, Slack, Discord or a webhook." },
  { icon: FolderKanban, title: "Projects and people", body: "Organisations, projects and roles, so each team and client sees only its own." },
];

function AlsoHere() {
  return (
    <section className="border-b border-border">
      <Wrap className="py-20 sm:py-28">
        <div className="mb-12"><Eyebrow>Also in backwork</Eyebrow><H2>The rest of the picture is still here.</H2></div>
        <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
          {ALSO.map(({ icon: Icon, title, body }) => (
            <div key={title} className="rounded-2xl border border-border p-[22px]">
              <Icon className="h-[18px] w-[18px] text-muted" />
              <h3 className="mt-4 text-[16px] font-semibold">{title}</h3>
              <p className="mt-1.5 text-[14px] text-muted">{body}</p>
            </div>
          ))}
        </div>
        <div className="mt-7 flex items-start gap-2.5 text-[14.5px] text-muted">
          <ShieldCheck className="mt-[3px] h-4 w-4 shrink-0 text-ok" />
          <span><b className="text-fg">No fake green.</b> When data stops arriving, backwork says “no data”. It never shows a service as healthy because it heard nothing.</span>
        </div>
      </Wrap>
    </section>
  );
}

export function MarketingLanding({ authed }: { authed?: boolean }) {
  return (
    <MarketingShell authed={authed} active={NavKey.Product}>
      <JsonLd data={{
        "@context": "https://schema.org", "@type": "SoftwareApplication", name: "backwork", url: SITE,
        applicationCategory: "DeveloperApplication", operatingSystem: "Web",
        description: "Request tracing and performance monitoring from plain log lines. Follow any request from one ID.",
        offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
      }} />
      <Hero />
      <WorksWith />
      <ThreeAnswers />
      <Performance />
      <Setup />
      <Control />
      <AlsoHere />
      <CtaBand />
    </MarketingShell>
  );
}
