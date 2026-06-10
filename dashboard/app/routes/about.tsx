import type { LoaderFunctionArgs, MetaFunction } from "@remix-run/node";
import { json } from "@remix-run/node";
import { Link, useLoaderData } from "@remix-run/react";
import { ArrowRight, Server, Eye, Layers, Github } from "lucide-react";
import { getUser } from "~/lib/auth/context.server";
import { MarketingShell, seo, REPO } from "~/components/marketing";

export const meta: MetaFunction = () =>
  seo({
    title: "About — backwork",
    description: "Why we built backwork: observability you own, a single honest pane, built on open standards — not another per-gigabyte bill.",
    path: "/about",
  });

export async function loader({ request }: LoaderFunctionArgs) {
  return json({ authed: !!(await getUser(request)) });
}

const VALUES = [
  { icon: Server, title: "You own your data", body: "Observability data describes exactly how your systems work. It should live on your infrastructure, not someone else's billing system." },
  { icon: Eye, title: "Honesty over theatre", body: "A dashboard is only useful if you can trust it. We never coerce missing data to zero or paint a dead pipeline green." },
  { icon: Layers, title: "One pane, open standards", body: "Logs, metrics and traces belong together — built on OpenTelemetry, Loki, VictoriaMetrics and Jaeger, not a walled garden." },
];

export default function About() {
  const { authed } = useLoaderData<typeof loader>();
  return (
    <MarketingShell authed={authed}>
      <section className="mx-auto max-w-3xl px-5 pt-16 pb-10 text-center sm:px-6 lg:pt-24">
        <div data-reveal>
          <div className="inline-flex items-center gap-1.5 rounded-full border border-border bg-surface px-3 py-1 text-2xs font-medium text-muted"><span className="h-1.5 w-1.5 rounded-full bg-brand" />About</div>
          <h1 className="mt-5 text-4xl font-semibold leading-tight tracking-tight sm:text-5xl">Observability you actually own.</h1>
          <p className="mx-auto mt-5 max-w-xl text-[15px] leading-relaxed text-muted sm:text-base">backwork started from a simple frustration: monitoring had become five disconnected tools, a per-gigabyte bill that scaled with your success, and dashboards that quietly lied when the data behind them stopped flowing.</p>
        </div>
      </section>

      <section className="mx-auto max-w-3xl px-5 sm:px-6">
        <div data-reveal className="space-y-4 text-[14.5px] leading-relaxed text-muted">
          <p>So we built the opposite. One self-hosted stack that brings logs, metrics, distributed traces, requests, incidents and alerts into a single pane — running on your own hardware, with one Docker command, for free.</p>
          <p>It's multi-tenant from the ground up, so a whole team (or a whole fleet of customers) can share one deployment with strict per-tenant isolation. It's OpenTelemetry-native, so it works with the instrumentation you already have. And it's engineered to tell the truth: an outage in the telemetry path reads as <span className="font-medium text-fg">no data</span>, never <span className="font-medium text-fg">all clear</span>.</p>
          <p>backwork is open source. Read the code, run it yourself, or let us host it — either way, the data stays yours.</p>
        </div>
      </section>

      <section className="mx-auto max-w-5xl px-5 py-14 sm:px-6">
        <div className="grid divide-y divide-border overflow-hidden rounded-2xl border border-border bg-surface md:grid-cols-3 md:divide-x md:divide-y-0">
          {VALUES.map((v, i) => (
            <div key={v.title} data-reveal className="p-6">
              <div className="flex items-center gap-3">
                <span className="grid h-10 w-10 place-items-center rounded-xl bg-brand/10 text-brand"><v.icon className="h-5 w-5" /></span>
                <span className="font-mono text-[13px] text-faint">0{i + 1}</span>
              </div>
              <h2 className="mt-4 text-base font-semibold">{v.title}</h2>
              <p className="mt-1.5 text-[13.5px] leading-relaxed text-muted">{v.body}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="mx-auto max-w-3xl px-5 pb-20 text-center sm:px-6">
        <div data-reveal className="flex flex-wrap items-center justify-center gap-3">
          <Link to="/register" className="inline-flex h-11 items-center gap-2 rounded-xl bg-brand px-5 text-sm font-semibold text-brand-fg hover:opacity-90">Start free <ArrowRight className="h-4 w-4" /></Link>
          <a href={REPO} target="_blank" rel="noreferrer" className="inline-flex h-11 items-center gap-2 rounded-xl border border-border-strong px-5 text-sm font-semibold text-fg hover:bg-surface-2"><Github className="h-4 w-4" /> Read the code</a>
        </div>
      </section>
    </MarketingShell>
  );
}
