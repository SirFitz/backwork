import type { LoaderFunctionArgs, MetaFunction } from "@remix-run/node";
import { json } from "@remix-run/node";
import { Link, useLoaderData } from "@remix-run/react";
import { ArrowRight } from "lucide-react";
import { getUser } from "~/lib/auth/context.server";
import { MarketingShell, seo, REPO } from "~/components/marketing";

export const meta: MetaFunction = () =>
  seo({
    title: "Docs — get started with backwork",
    description: "Ship logs, metrics and traces to backwork in minutes: create a project, install the agent, point OpenTelemetry at one endpoint. Concepts, self-hosting and multi-tenancy.",
    path: "/docs",
  });

export async function loader({ request }: LoaderFunctionArgs) {
  return json({ authed: !!(await getUser(request)) });
}

function Code({ children }: { children: string }) {
  return <pre className="overflow-x-auto scroll-thin rounded-lg border border-border bg-bg px-3.5 py-3 font-mono text-[12px] leading-relaxed text-fg/90">{children}</pre>;
}
function H2({ id, children }: { id: string; children: string }) {
  return <h2 id={id} className="scroll-mt-24 pt-10 text-xl font-semibold tracking-tight">{children}</h2>;
}
function P({ children }: { children: React.ReactNode }) {
  return <p className="mt-3 text-[14px] leading-relaxed text-muted">{children}</p>;
}

const TOC = [
  ["quickstart", "Quickstart"],
  ["projects", "Projects & tokens"],
  ["logs-metrics", "Logs & metrics agent"],
  ["traces", "Traces (OpenTelemetry)"],
  ["concepts", "Concepts"],
  ["self-host", "Self-hosting"],
  ["tenancy", "Organizations & teams"],
];

export default function Docs() {
  const { authed } = useLoaderData<typeof loader>();
  return (
    <MarketingShell authed={authed}>
      <div className="mx-auto max-w-6xl px-5 py-12 sm:px-6 lg:grid lg:grid-cols-[200px_1fr] lg:gap-10 lg:py-16">
        {/* TOC */}
        <aside className="hidden lg:block">
          <div className="sticky top-24">
            <div className="text-2xs font-semibold uppercase tracking-wide text-faint">On this page</div>
            <nav className="mt-3 space-y-1.5">
              {TOC.map(([id, label]) => (
                <a key={id} href={`#${id}`} className="block text-[13px] text-muted hover:text-fg">{label}</a>
              ))}
            </nav>
            <a href={REPO} target="_blank" rel="noreferrer" className="mt-6 inline-flex items-center gap-1.5 text-[13px] font-medium text-brand hover:underline">GitHub repo <ArrowRight className="h-3.5 w-3.5" /></a>
          </div>
        </aside>

        <article className="max-w-2xl">
          <div className="inline-flex items-center gap-1.5 rounded-full border border-border bg-surface px-3 py-1 text-2xs font-medium text-muted"><span className="h-1.5 w-1.5 rounded-full bg-brand" />Docs</div>
          <h1 className="mt-4 text-3xl font-semibold tracking-tight sm:text-4xl">Get started</h1>
          <P>backwork unifies logs, metrics and traces in one self-hosted dashboard. You can be sending real telemetry in about five minutes — create a project, drop an agent on a host, and point OpenTelemetry at a single endpoint.</P>

          <H2 id="quickstart">Quickstart</H2>
          <P>Three steps from zero to a live dashboard:</P>
          <ol className="mt-4 space-y-3 text-[14px] text-muted">
            <li><span className="font-medium text-fg">1. Create a project</span> in <Link to="/projects" className="text-brand hover:underline">Projects</Link> and copy its one-time ingest token.</li>
            <li><span className="font-medium text-fg">2. Ship telemetry</span> — run the agent for logs &amp; metrics, or set the OTLP env vars for traces.</li>
            <li><span className="font-medium text-fg">3. Watch it live</span> — the dashboard auto-refreshes, detects incidents and routes alerts.</li>
          </ol>

          <H2 id="projects">Projects &amp; tokens</H2>
          <P>A <span className="font-medium text-fg">project</span> is an app or environment you ship telemetry from. Each project has its own ingest token, and all data sent with that token is isolated to your organization. The token is shown once on creation — copy it then, or regenerate a new one (which invalidates the old).</P>

          <H2 id="logs-metrics">Logs &amp; metrics agent</H2>
          <P>One command installs a Vector + exporter agent on any host. It forwards that host's container logs and, optionally, host/container metrics:</P>
          <Code>{`curl -fsSL https://backwork.dev/install.sh | sh -s -- \\
  --token <YOUR_INGEST_TOKEN> \\
  --name $(hostname) \\
  --metrics host        # host | container | all | none`}</Code>
          <P>Logs appear under <span className="font-mono text-[13px]">Logs</span>; host metrics (node-exporter) and per-container metrics (cAdvisor) under <span className="font-mono text-[13px]">Metrics</span>.</P>

          <H2 id="traces">Traces (OpenTelemetry)</H2>
          <P>The fastest path is the backwork SDK — it wires OpenTelemetry to your project in one line. Install it, set <span className="font-mono text-[13px]">BACKWORK_TOKEN</span> to your project token, and preload it:</P>
          <Code>{`# Node
npm i @sirfitz/backwork
BACKWORK_TOKEN=<YOUR_INGEST_TOKEN> BACKWORK_SERVICE=my-api \\
  node --import @sirfitz/backwork/register server.js

# Bun
bun add @sirfitz/backwork
BACKWORK_TOKEN=<YOUR_INGEST_TOKEN> bun --preload @sirfitz/backwork/start run server.ts`}</Code>
          <P><span className="font-medium text-fg">Elixir</span> — add <span className="font-mono text-[13px]">{"{:backwork, \"~> 0.1\"}"}</span> to your deps, then:</P>
          <Code>{`# config/runtime.exs
config :opentelemetry, traces_exporter: :otlp
config :opentelemetry_exporter, Backwork.exporter_config()

# application.ex — before your supervisor children
Backwork.setup(phoenix_adapter: :bandit, ecto: [[:my_app, :repo]])`}</Code>
          <P>Prefer raw OpenTelemetry? backwork speaks OTLP natively — point any OTel SDK or Collector at one endpoint with your token, no SDK required:</P>
          <Code>{`OTEL_EXPORTER_OTLP_ENDPOINT=https://backwork.dev/otlp
OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
OTEL_EXPORTER_OTLP_HEADERS=Authorization=Bearer <YOUR_INGEST_TOKEN>
OTEL_SERVICE_NAME=your-service`}</Code>
          <P>Spans show up under <span className="font-mono text-[13px]">Traces</span> (with a waterfall), <span className="font-mono text-[13px]">Requests</span> (a flat RED feed) and <span className="font-mono text-[13px]">Metrics → Application performance</span>.</P>

          <H2 id="concepts">Concepts</H2>
          <P><span className="font-medium text-fg">Logs</span> are searchable with full-text or LogQL. <span className="font-medium text-fg">Metrics</span> are queried with PromQL under the hood. <span className="font-medium text-fg">Traces</span> follow a request across services. <span className="font-medium text-fg">Requests</span> distil traces into method/route/status/latency. <span className="font-medium text-fg">Incidents</span> are detected automatically from container state, metrics and logs. <span className="font-medium text-fg">Alerts</span> evaluate rules and notify via Slack, Discord, webhook, email or SMS — and report a no-data state rather than faking “all clear” during an outage.</P>

          <H2 id="self-host">Self-hosting</H2>
          <P>backwork is open source and runs anywhere Docker does. Clone the repo and bring the stack up:</P>
          <Code>{`git clone ${REPO.replace("https://github.com/", "https://github.com/")}.git
cd backwork
docker compose up -d`}</Code>
          <P>Under the hood it composes Loki (logs), VictoriaMetrics (metrics), Jaeger (traces) and Vector (collection) behind the dashboard. Your telemetry never leaves your infrastructure.</P>

          <H2 id="tenancy">Organizations &amp; teams</H2>
          <P>backwork is multi-tenant. Create organizations, invite members with roles (owner, admin, member, viewer), group them into teams, and issue per-project ingest tokens. Every org's logs, metrics and traces are isolated server-side by an enforced tenant id — see <Link to="/security" className="text-brand hover:underline">Security</Link> for the details.</P>

          <div className="mt-12 rounded-2xl border border-border-strong bg-surface p-6 text-center">
            <h2 className="text-lg font-semibold">Ready to ship telemetry?</h2>
            <p className="mx-auto mt-2 max-w-md text-[13.5px] text-muted">Create an account and your first project in under a minute.</p>
            <Link to="/register" className="mt-4 inline-flex h-10 items-center gap-2 rounded-xl bg-brand px-4 text-sm font-semibold text-brand-fg hover:opacity-90">Start free <ArrowRight className="h-4 w-4" /></Link>
          </div>
        </article>
      </div>
    </MarketingShell>
  );
}
