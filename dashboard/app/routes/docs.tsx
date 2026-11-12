import type { LoaderFunctionArgs, MetaFunction } from "@remix-run/node";
import { json } from "@remix-run/node";
import { Link, useLoaderData } from "@remix-run/react";
import { ArrowRight } from "lucide-react";
import { getUser } from "~/lib/auth/context.server";
import { MarketingShell, seo, REPO } from "~/components/marketing";

export const meta: MetaFunction = () =>
  seo({
    title: "Docs — get started with backwork",
    description: "Send requests and logs to backwork in minutes: create a project, add Correlator to your services, install the agent. Concepts, self-hosting and multi-tenancy.",
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
  ["agent", "The agent"],
  ["correlator", "Requests (Correlator)"],
  ["errors-api", "Errors & API"],
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
          <P>backwork shows every request across your services: the path it took, where the time went, where it stopped and the log lines it wrote, with figures per service and route and a log search. You can be sending real requests in about five minutes: create a project, add Correlator to a service, and run the agent on its host.</P>

          <H2 id="quickstart">Quickstart</H2>
          <P>Three steps from zero to a live dashboard:</P>
          <ol className="mt-4 space-y-3 text-[14px] text-muted">
            <li><span className="font-medium text-fg">1. Create a project</span> in <Link to="/projects" className="text-brand hover:underline">Projects</Link> and copy its one-time ingest token.</li>
            <li><span className="font-medium text-fg">2. Add Correlator</span> to each service, so it writes a start and an end line for every request, job and call.</li>
            <li><span className="font-medium text-fg">3. Run the agent</span> on each host. Requests appear within a minute; paste any ID into the header search to open one.</li>
          </ol>

          <H2 id="projects">Projects &amp; tokens</H2>
          <P>A <span className="font-medium text-fg">project</span> is an app or environment you send data from. Each project has its own ingest token, and all data sent with that token is isolated to your organization. The token is shown once on creation: copy it then, or regenerate a new one (which invalidates the old).</P>

          <H2 id="agent">The agent</H2>
          <P>One command installs the agent (Vector only) on any host. It forwards that host's container logs, or PM2's log files, with the hop records Correlator writes, and the request figures derived from them:</P>
          <Code>{`curl -fsSL https://backwork.dev/install.sh | sh -s -- \\
  --token <YOUR_INGEST_TOKEN> \\
  --name $(hostname)
# --include api-,worker-   only containers whose names start with these
# --instance a             a second agent on the same host`}</Code>
          <P>Sensitive values (card numbers, emails, phone numbers, passwords, tokens and your own patterns) are replaced with <span className="font-mono text-[13px]">[filtered]</span> on the host, before anything leaves it. Every kind of data has a switch under <Link to="/projects" className="text-brand hover:underline">Projects</Link> and <Link to="/settings" className="text-brand hover:underline">Settings</Link>.</P>

          <H2 id="correlator">Requests (Correlator)</H2>
          <P>Correlator carries one trace ID through every service a request crosses and writes a short hop record when a request, job or call starts and when it ends. It runs beside AppSignal, Sentry or anything else you use. In Node or Bun it is one line:</P>
          <Code>{`node --import correlator/auto server.js
# or:  bun --preload correlator/auto server.ts
# or, as the first import:  import "correlator/auto"`}</Code>
          <P><span className="font-medium text-fg">Elixir</span>: <span className="font-mono text-[13px]">mix correlator.install</span> adds <span className="font-mono text-[13px]">Correlator.setup()</span> to your application start.</P>
          <P>Requests then show up under <span className="font-mono text-[13px]">Requests</span>, <span className="font-mono text-[13px]">Performance</span> and the Overview, and any ID (trace ID, request ID, UUID or <span className="font-mono text-[13px]">traceparent</span>) opens the request view from the header search. Health checks (<span className="font-mono text-[13px]">/healthz</span>, <span className="font-mono text-[13px]">/ready</span> and the like) are left out of the lists and figures unless you turn on “Show health checks”.</P>

          <H2 id="errors-api">Errors &amp; API</H2>
          <P><span className="font-medium text-fg">Report exceptions</span> by POSTing them with your project ingest token — backwork fingerprints and groups them under <span className="font-mono text-[13px]">Errors</span> (a new occurrence reopens a resolved group; ignored ones stay muted):</P>
          <Code>{`curl -X POST https://backwork.dev/ingest/errors \\
  -H "Authorization: Bearer <YOUR_INGEST_TOKEN>" \\
  -H "Content-Type: application/json" \\
  -d '{"type":"TypeError","message":"Cannot read x of undefined","service":"my-api","stack":"...","environment":"production"}'`}</Code>
          <P><span className="font-medium text-fg">Read your data over HTTP.</span> Create a read-only API key in the org menu under <span className="font-mono text-[13px]">API keys</span>, then query the bearer-authed, org-scoped JSON API:</P>
          <Code>{`curl -H "Authorization: Bearer <API_KEY>" https://backwork.dev/api/v1/errors
# also: /api/v1/me  ·  /api/v1/services?range=1h`}</Code>
          <P>Or use the <span className="font-medium text-fg">CLI</span>:</P>
          <Code>{`npm i -g @sirfitz/backwork-cli
export BACKWORK_API_KEY=<API_KEY>
bw errors --status open      # also: bw me · bw services · --json`}</Code>

          <H2 id="concepts">Concepts</H2>
          <P>A <span className="font-medium text-fg">hop</span> is one service's part of a request: a request in, a job run, or a call out to another service, a database or a cache. The <span className="font-medium text-fg">request view</span> puts the hops of one trace ID together, with their time, gaps and log lines. <span className="font-medium text-fg">Requests</span> lists every inbound HTTP request. <span className="font-medium text-fg">Performance</span> turns hops into rate, errors and latency per service, route and connection. <span className="font-medium text-fg">Logs</span> are searchable with full-text or LogQL. <span className="font-medium text-fg">Alerts</span> watch error and log rates and notify via Slack, Discord, webhook, email or SMS, and report a no-data state rather than faking “all clear” during an outage.</P>

          <H2 id="self-host">Self-hosting</H2>
          <P>backwork is open source and runs anywhere Docker does. Clone the repo and bring the stack up:</P>
          <Code>{`git clone ${REPO.replace("https://github.com/", "https://github.com/")}.git
cd backwork
docker compose up -d`}</Code>
          <P>Five containers: Vector (collection), Loki (log lines and hop records), VictoriaMetrics (request figures), Postgres (accounts and settings) and the dashboard. Your data never leaves your infrastructure.</P>

          <H2 id="tenancy">Organizations &amp; teams</H2>
          <P>backwork is multi-tenant. Create organizations, invite members with roles (owner, admin, member, viewer), group them into teams, and issue per-project ingest tokens. Every org's requests, figures and log lines are isolated server-side by an enforced tenant id — see <Link to="/security" className="text-brand hover:underline">Security</Link> for the details.</P>

          <div className="mt-12 rounded-2xl border border-border-strong bg-surface p-6 text-center">
            <h2 className="text-lg font-semibold">Ready to find your first request?</h2>
            <p className="mx-auto mt-2 max-w-md text-[13.5px] text-muted">Create an account and your first project in under a minute.</p>
            <Link to="/register" className="mt-4 inline-flex h-10 items-center gap-2 rounded-xl bg-brand px-4 text-sm font-semibold text-brand-fg hover:opacity-90">Start free <ArrowRight className="h-4 w-4" /></Link>
          </div>
        </article>
      </div>
    </MarketingShell>
  );
}
