import type { LoaderFunctionArgs, MetaFunction } from "@remix-run/node";
import { json } from "@remix-run/node";
import { Link, useLoaderData } from "@remix-run/react";
import type { ReactNode } from "react";
import { ArrowRight, Info } from "lucide-react";
import { MarketingShell, NavKey, seo } from "~/components/marketing";
import { $, AGENT, CodeBlock, CodeTabs, CodeTone, INSTALL, Runtime, c, p } from "~/components/site/code-tabs";
import { getUser } from "~/lib/auth/context.server";

export const meta: MetaFunction = () =>
  seo({
    title: "Docs — backwork",
    description: "Add backwork to a service in a minute: one package, one start line, and the agent on each server. Find a request by any ID, read its path, and control what is collected.",
    path: "/docs",
  });

export async function loader({ request }: LoaderFunctionArgs) {
  return json({ authed: !!(await getUser(request)) });
}

const GROUPS: [string, [string, string][]][] = [
  ["Get started", [["add-a-service", "Add backwork to a service"], ["agent", "Install the agent on a server"], ["first-request", "Find your first request"]]],
  ["Guides", [["linked-ids", "Find a request by order number"], ["databases", "Database and cache timing"], ["jobs", "Background jobs"], ["other-monitors", "Next to Sentry or OpenTelemetry"], ["switches", "Switches"], ["filter", "Sensitive-data filter"]]],
  ["Features", [["request-view", "Request view"], ["performance", "Performance"], ["logs", "Log search"], ["errors", "Errors"], ["alerts", "Needs attention and alerts"]]],
  ["Reference", [["options", "Correlator options"], ["agent-options", "Agent options"], ["api", "Read API and CLI"], ["organisations", "Organisations and roles"]]],
];

function H2({ id, children }: { id: string; children: ReactNode }) {
  return <h2 id={id} className="mt-14 scroll-mt-24 text-[22px] font-semibold tracking-[-0.02em] first:mt-0">{children}</h2>;
}
function H3({ children }: { children: ReactNode }) {
  return <h3 className="mt-8 text-[17px] font-semibold">{children}</h3>;
}
function P({ children }: { children: ReactNode }) {
  return <p className="mt-3 text-[15.5px] leading-[1.7]">{children}</p>;
}
function M({ children }: { children: ReactNode }) {
  return <code className="rounded bg-surface-2 px-1 py-px font-mono text-[13.5px]">{children}</code>;
}
function Table({ head, rows }: { head: string[]; rows: ReactNode[][] }) {
  return (
    <div className="mt-4 overflow-x-auto rounded-xl border border-border">
      <table className="w-full min-w-[520px] border-collapse text-[14px]">
        <thead><tr>{head.map((h) => <th key={h} className="border-b border-border bg-surface px-4 py-2.5 text-left text-[12px] font-medium uppercase tracking-wide text-faint">{h}</th>)}</tr></thead>
        <tbody>{rows.map((r, i) => <tr key={i} className="border-b border-border last:border-b-0">{r.map((cell, j) => <td key={j} className="px-4 py-2.5 align-top">{cell}</td>)}</tr>)}</tbody>
      </table>
    </div>
  );
}

const OPTIONS: [string, string, string][] = [
  ["service", "none", "The name this service gives itself in the request view."],
  ["hop_records", "on", "on, off or sampled. Hop records are what backwork builds request paths from."],
  ["store_hops", "on", "Record database and cache calls as timed steps."],
  ["named_fields", "on", "Record values set with annotate."],
  ["linked_ids", "on", "Record IDs set with link."],
  ["log_fields", "on", "Add trace_id and linked IDs to every log line."],
  ["correlation_headers", "x-correlation-id, x-request-id", "Plain headers read on the way in, in order."],
  ["echo_headers", "x-request-id", "Headers set on every response, so a client can quote the ID."],
  ["link_response_headers", "none", "Response headers from other companies' APIs to keep as linked IDs."],
  ["enabled", "true", "The master switch. With false, Correlator does nothing at all."],
];

export default function Docs() {
  const { authed } = useLoaderData<typeof loader>();
  return (
    <MarketingShell authed={authed} active={NavKey.Docs}>
      <div className="mx-auto grid max-w-[1440px] lg:grid-cols-[272px_minmax(0,1fr)] xl:grid-cols-[272px_minmax(0,1fr)_232px]">
        <aside className="hidden border-r border-border bg-surface px-5 pb-12 pt-6 lg:block">
          <nav className="sticky top-24" aria-label="Docs">
            {GROUPS.map(([g, items]) => (
              <div key={g} className="mt-6 first:mt-0">
                <h5 className="mb-1.5 pl-2.5 text-[12px] font-semibold uppercase tracking-wide text-faint">{g}</h5>
                {items.map(([id, label]) => <a key={id} href={`#${id}`} className="block rounded-md px-2.5 py-1.5 text-[14px] text-muted hover:bg-surface-2 hover:text-fg">{label}</a>)}
              </div>
            ))}
          </nav>
        </aside>

        <article className="min-w-0 px-4 pb-24 pt-10 sm:px-10 lg:px-16 lg:pt-12">
          <div className="max-w-[760px]">
            <div className="text-[13px] text-faint">Docs <span className="mx-1.5">/</span> Get started</div>
            <h1 id="add-a-service" className="mt-3 scroll-mt-24 text-[32px] font-semibold leading-[1.1] tracking-[-0.03em] sm:text-[38px]">Add backwork to a service</h1>
            <p className="mt-3.5 text-[17px] leading-relaxed text-muted">About a minute per service. You add one package, start the service with it, and install the agent once on each server. Nothing else in your code changes.</p>
            <div className="mt-7 flex gap-2.5 rounded-xl border border-info/30 bg-info/5 px-4 py-3.5 text-[14.5px]">
              <Info className="mt-[3px] h-4 w-4 shrink-0 text-info" />
              <div><b>Before you start.</b> You need a backwork project and its ingest token. <Link to="/register" className="text-brand hover:underline">Create an account</Link>, then a project under <b>Projects</b>. Node 18, Bun 1.2 or Elixir 1.14 and newer.</div>
            </div>

            <H3>1. Add Correlator</H3>
            <P>One package for every framework. Correlator finds what your service uses (Express, Hono, Fastify, Remix, Phoenix, BullMQ, Oban, Ecto, Postgres clients) and attaches to each one by itself.</P>
            <CodeTabs tone={CodeTone.Light} className="mt-4" samples={{
              [Runtime.Node]: [$("npm install correlator")],
              [Runtime.Bun]: [$("bun add correlator")],
              [Runtime.Elixir]: [c("# mix.exs, in deps"), p('{:correlator, "~> 0.1"}')],
            }} />
            <H3>2. Start your service with it</H3>
            <P>No code change: start the service with Correlator loaded first.</P>
            <CodeTabs tone={CodeTone.Light} className="mt-4" samples={{
              [Runtime.Node]: INSTALL[Runtime.Node].slice(-1),
              [Runtime.Bun]: INSTALL[Runtime.Bun].slice(-1),
              [Runtime.Elixir]: [c("# application.ex, first line of start/2"), p("Correlator.setup()")],
            }} />
            <P>Prefer a line in your code? In Node and Bun, make <M>import "correlator/auto"</M> the first import.</P>
            <H3>3. Check it worked</H3>
            <P>Ask Correlator what it attached to. Anything it found but could not attach is listed with the reason.</P>
            <CodeBlock className="mt-4" lines={[
              c("// in your service, once it has started"),
              p('import { status } from "correlator";'),
              p("console.log(status());"),
              p(""),
              c("// attached   hono, fetch, node-postgres, pino"),
              c("// found      ioredis (add @correlator/ioredis for cache timing)"),
              c("// switches   hop_records on · named_fields on · linked_ids on"),
            ]} />

            <H2 id="agent">Install the agent on a server</H2>
            <P>The agent reads your services' log lines and sends them to backwork. It runs once per server, not once per service, and it removes sensitive data before anything leaves the server.</P>
            <CodeBlock className="mt-4" lines={AGENT.slice(1)} />
            <P>Your services keep logging to standard output, as they do today. Your service itself needs no backwork token, endpoint or package.</P>

            <H2 id="first-request">Find your first request</H2>
            <P>Send any request to your service, then open backwork and paste an ID into the search box at the top of every page. Any of these finds the request:</P>
            <Table head={["You have", "Example", "Where it comes from"]} rows={[
              ["A trace ID", <M key="a">6503f5f183b828139d5b143365ad72fa</M>, "The traceparent header, or trace_id in a log line"],
              ["A request ID", <M key="b">F8Zx2o1yQk0AAAEB</M>, "The x-request-id response header, quoted by a client or in a support ticket"],
              ["A linked ID", <M key="c">order_id 7731</M>, "Anything your code recorded with link, such as an order number"],
            ]} />

            <H2 id="linked-ids">Find a request by order number</H2>
            <P>Record the IDs people actually quote. Once linked, they find the request like any other ID.</P>
            <CodeTabs tone={CodeTone.Light} className="mt-4" samples={{
              [Runtime.Node]: [p('import { link, annotate } from "correlator";'), p(""), p('link("order_id", order.id);        // findable by this ID'), p('annotate("currency", order.currency); // shown on this step')],
              [Runtime.Elixir]: [p('Correlator.link("order_id", order.id)'), p('Correlator.annotate("currency", order.currency)')],
            }} />
            <P>To keep IDs that another company's API sends back, list the header in <M>link_response_headers</M>. Values are never read from request or response bodies.</P>

            <H2 id="databases">Database and cache timing</H2>
            <P>Database and cache calls appear as timed steps under the request that made them, with the time only: never the query's values. Clients in the language's standard library are covered by Correlator itself. For others, add the matching package (for example <M>@correlator/ioredis</M>); <M>status()</M> tells you which one you are missing.</P>

            <H2 id="jobs">Background jobs</H2>
            <P>When a request queues a job, the ID travels with it. The job shows up in the request view under the request that queued it, even if it ran minutes later on another server. BullMQ and Oban are covered; a queued job that never reports back is shown as a gap.</P>

            <H2 id="other-monitors">Next to Sentry or OpenTelemetry</H2>
            <P>Correlator runs alongside whatever you already use. It reads Sentry's <M>sentry-trace</M> header, and its trace ID is the OpenTelemetry trace ID, so one ID follows the request through all of them.</P>

            <H2 id="switches">Switches</H2>
            <P>Everything backwork collects has a switch, and everything starts on. Owners and admins can switch log lines, request paths, database calls, named fields, linked IDs or performance figures off for the whole organisation, one project or one service, under <b>Projects</b>. A developer can do the same in the service's own options. Off in either place means off, and every change is written to the audit log.</P>

            <H2 id="filter">Sensitive-data filter</H2>
            <P>The filter runs on every line before it is saved: first in the agent, so the data never leaves your server, and again when backwork receives it. It is on by default and replaces what it finds with <M>[filtered]</M>.</P>
            <P>Built in: payment card numbers, email addresses, phone numbers, passwords, API keys and tokens. Each organisation can add its own patterns, such as member or account numbers.</P>

            <H2 id="request-view">Request view</H2>
            <P>One request on one page: every step it took, as a tree in the order it happened; how long each took; what each service logged while handling it; and, when it never finished, where it stopped. A step that was sent but never received is marked as a gap.</P>
            <H2 id="performance">Performance</H2>
            <P>Every finished step becomes a timing. The Performance page shows the typical and the slow (p95) time per route, service, database and cache, with the share spent waiting on each, and links from a slow route straight to real slow requests.</P>
            <H2 id="logs">Log search</H2>
            <P>Search every line from every service, by text, level, service and time, or with LogQL. A line that carries a trace ID links to its request.</P>
            <H2 id="errors">Errors</H2>
            <P>Errors are grouped by cause. A new occurrence reopens a resolved group; ignored groups stay quiet. You can also report errors directly:</P>
            <CodeBlock className="mt-4" lines={[
              $("curl -X POST https://backwork.dev/ingest/errors \\"),
              p('  -H "Authorization: Bearer <TOKEN>" -H "Content-Type: application/json" \\'),
              p(`  -d '{"type":"TypeError","message":"Cannot read x of undefined","service":"my-api","stack":"..."}'`),
            ]} />
            <H2 id="alerts">Needs attention and alerts</H2>
            <P>The Overview lists services failing or slower than usual, requests that stopped and calls that were never received. Alert rules send to email, Slack, Discord or a webhook. When data stops arriving backwork says “no data”; it never shows a service as healthy because it heard nothing.</P>

            <H2 id="options">Correlator options</H2>
            <P>Every option has a default, and every feature is on. Set options in code before the first request, or switch a feature off from the dashboard.</P>
            <Table head={["Option", "Default", "What it does"]} rows={OPTIONS.map(([k, d, w]) => [<M key={k}>{k}</M>, <span key="d" className="font-mono text-[13px] text-muted">{d}</span>, w])} />

            <H2 id="agent-options">Agent options</H2>
            <Table head={["Option", "What it does"]} rows={[
              [<M key="t">--token</M>, "Your project's ingest token. Required."],
              [<M key="n">--name</M>, "The name this server shows in backwork. Defaults to its host name."],
            ]} />

            <H2 id="api">Read API and CLI</H2>
            <P>Create a read-only API key under <b>API keys</b> in the organisation menu, then query your organisation's data as JSON:</P>
            <CodeBlock className="mt-4" lines={[$('curl -H "Authorization: Bearer <API_KEY>" https://backwork.dev/api/v1/errors'), c("# also: /api/v1/me · /api/v1/services")]} />
            <P>Or use the CLI:</P>
            <CodeBlock className="mt-4" lines={[$("npm i -g @sirfitz/backwork-cli"), $("export BACKWORK_API_KEY=<API_KEY>"), $("bw errors --status open"), c("# also: bw me · bw services · --json")]} />

            <H2 id="organisations">Organisations and roles</H2>
            <P>Each organisation's data is kept apart from every other's. Invite people with a role (owner, admin, member or viewer), group them into teams, and give each project its own ingest token. See <Link to="/security" className="text-brand hover:underline">Security</Link> for how data is kept apart.</P>

            <Link to="/register" className="mt-14 inline-grid min-w-[300px] grid-cols-[1fr_auto] items-center gap-x-5 gap-y-0.5 rounded-xl border border-border px-5 py-4 hover:bg-surface">
              <span className="text-[12.5px] text-faint">Ready?</span>
              <b className="col-start-1 text-[15.5px] font-semibold">Create your first project</b>
              <ArrowRight className="col-start-2 row-span-2 row-start-1 h-4 w-4 text-brand" />
            </Link>
          </div>
        </article>

        <aside className="hidden px-6 pt-12 xl:block">
          <div className="sticky top-24">
            <h5 className="mb-2.5 text-[12px] font-semibold uppercase tracking-wide text-faint">On this page</h5>
            {[["add-a-service", "Add a service"], ["agent", "Install the agent"], ["first-request", "Find a request"], ["switches", "Switches"], ["filter", "Filter"], ["options", "Options"], ["api", "API and CLI"]].map(([id, l]) => (
              <a key={id} href={`#${id}`} className="block border-l border-border py-1 pl-3 text-[13.5px] text-muted hover:border-brand hover:text-fg">{l}</a>
            ))}
          </div>
        </aside>
      </div>
    </MarketingShell>
  );
}
