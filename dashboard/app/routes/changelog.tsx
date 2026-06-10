import type { LoaderFunctionArgs, MetaFunction } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import { ArrowRight } from "lucide-react";
import { getUser } from "~/lib/auth/context.server";
import { MarketingShell, seo, REPO } from "~/components/marketing";
import { cn } from "~/lib/utils";

export const meta: MetaFunction = () =>
  seo({ title: "Changelog — backwork", description: "What's new in backwork: features, improvements, fixes and security updates.", path: "/changelog" });

export async function loader({ request }: LoaderFunctionArgs) {
  return json({ authed: !!(await getUser(request)) });
}

type Tag = "Added" | "Improved" | "Fixed" | "Security";
const TAG: Record<Tag, string> = {
  Added: "bg-ok/10 text-ok ring-ok/25",
  Improved: "bg-info/10 text-info ring-info/25",
  Fixed: "bg-warn/10 text-warn ring-warn/25",
  Security: "bg-brand/10 text-brand ring-brand/25",
};

const RELEASES: { date: string; version: string; title: string; items: [Tag, string][] }[] = [
  {
    date: "June 10, 2026", version: "v0.4", title: "Marketing site & design polish",
    items: [
      ["Added", "A public marketing site — landing, docs, pricing, security and about — with full SEO: OpenGraph and Twitter cards, JSON-LD, sitemap and robots."],
      ["Added", "Transactional email via AWS SES for password resets and team invitations."],
      ["Improved", "An end-to-end UI design pass: de-boxed dashboards, bento marketing layouts, a refined type scale, stronger dark mode and accessible contrast."],
      ["Fixed", "Marketing pages no longer render blank on client-side navigation."],
    ],
  },
  {
    date: "June 9, 2026", version: "v0.3", title: "Multi-tenant SaaS & security hardening",
    items: [
      ["Added", "Organizations, teams, roles and per-project ingest tokens, with byte-level tenant isolation across logs, metrics and traces."],
      ["Added", "A self-service account page and a complete forgot / reset-password flow."],
      ["Security", "Same-origin (CSRF) checks, per-IP/per-account auth rate-limiting, server-side session revocation, and fixes for a cross-tenant IDOR and alert-webhook SSRF."],
      ["Fixed", "The OTLP ingest proxy no longer drops span error status — trace and request errors now highlight correctly for every tenant."],
      ["Improved", "Honest no-data states across overview, incidents and alerts — an outage never reads as “healthy.”"],
    ],
  },
  {
    date: "June 9, 2026", version: "v0.2", title: "Observability core",
    items: [
      ["Added", "Unified logs (LogQL), metrics (host, container and APM-from-traces), distributed traces, a flat request feed, automatic incident detection and alerts."],
      ["Added", "Alert channels — Slack, Discord, webhook, email and SMS — with a background evaluator."],
      ["Added", "A one-command agent installer and OpenTelemetry-native OTLP ingest."],
      ["Improved", "Deferred streaming so page shells paint instantly."],
    ],
  },
  {
    date: "June 9, 2026", version: "v0.1", title: "First light",
    items: [["Added", "backwork goes live at backwork.dev — self-hosted logs, metrics and traces in one pane, on Loki, VictoriaMetrics, Jaeger and Vector."]],
  },
];

export default function Changelog() {
  const { authed } = useLoaderData<typeof loader>();
  return (
    <MarketingShell authed={authed}>
      <section className="mx-auto max-w-3xl px-5 pt-16 pb-10 sm:px-6 lg:pt-24">
        <div data-reveal>
          <div className="inline-flex items-center gap-1.5 rounded-full border border-border bg-surface px-3 py-1 text-2xs font-medium text-muted"><span className="h-1.5 w-1.5 rounded-full bg-brand" />Changelog</div>
          <h1 className="mt-5 text-4xl font-semibold leading-tight tracking-tight sm:text-5xl">What's new.</h1>
          <p className="mt-5 max-w-xl text-[15px] leading-relaxed text-muted sm:text-base">Every notable feature, improvement, fix and security update. For the full commit history, see <a href={REPO + "/commits/main"} target="_blank" rel="noreferrer" className="font-medium text-brand hover:underline">GitHub</a>.</p>
        </div>
      </section>

      <section className="mx-auto max-w-3xl px-5 pb-20 sm:px-6">
        <div className="ml-1 border-l border-border pl-7 sm:pl-9">
          {RELEASES.map((r) => (
            <div key={r.version} data-reveal className="relative pb-12 last:pb-0">
              <span className="absolute -left-[35px] top-1 h-3.5 w-3.5 rounded-full border-2 border-brand bg-bg sm:-left-[43px]" aria-hidden />
              <div className="flex items-center gap-2.5">
                <time className="font-mono text-2xs text-faint">{r.date}</time>
                <span className="rounded bg-surface-2 px-1.5 py-0.5 font-mono text-2xs text-muted">{r.version}</span>
              </div>
              <h2 className="mt-1.5 text-lg font-semibold tracking-tight">{r.title}</h2>
              <ul className="mt-3.5 space-y-2.5">
                {r.items.map(([tag, text], i) => (
                  <li key={i} className="flex gap-3">
                    <span className={cn("mt-0.5 inline-flex w-[68px] shrink-0 justify-center rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ring-1 ring-inset", TAG[tag])}>{tag}</span>
                    <span className="text-[13.5px] leading-relaxed text-muted">{text}</span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </section>
    </MarketingShell>
  );
}
