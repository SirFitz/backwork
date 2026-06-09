import type { LoaderFunctionArgs } from "@remix-run/node";
import { defer } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import { AlertTriangle, CheckCircle2, XCircle } from "lucide-react";
import { Link } from "@remix-run/react";
import { Card, CardHead, PageTitle } from "~/components/ui";
import { Deferred, RowsSkeleton } from "~/components/defer";
import { config } from "~/lib/config.server";
import * as vm from "~/lib/vm.server";
import * as jaeger from "~/lib/jaeger.server";
import { requireOrg } from "~/lib/auth/context.server";
import { tenantOf } from "~/lib/tenant.server";
import { cn } from "~/lib/utils";

async function ping(url: string): Promise<boolean> {
  try {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), 5000);
    const r = await fetch(url, { signal: c.signal });
    clearTimeout(t);
    return r.ok;
  } catch {
    return false;
  }
}

export async function loader({ request }: LoaderFunctionArgs) {
  const ctx = await requireOrg(request);
  const isPlatform = tenantOf(ctx.org.id).platform;
  const url = new URL(request.url);
  const settingsKey = process.env.SETTINGS_KEY || "";
  const showToken = !settingsKey || url.searchParams.get("key") === settingsKey;

  const health = Promise.all([
    // /ready can flap 503; the labels API is a truer "is Loki serving" check
    ping(`${config.lokiUrl}/loki/api/v1/labels`),
    vm.targetsUp().then((t) => ({ ok: true, t })).catch(() => ({ ok: false, t: {} as Record<string, boolean> })),
    jaeger.services().then(() => true).catch(() => false),
  ]).then(([lokiUp, targets, jaegerSvcs]) => ({
    loki: lokiUp,
    victoriametrics: targets.ok,
    cadvisor: !!targets.t["cadvisor"],
    vector: !!targets.t["vector"],
    jaeger: jaegerSvcs,
  }));

  return defer({
    publicUrl: config.publicUrl,
    isPlatform,
    // The legacy global token is platform-only; customer orgs use per-project
    // tokens from the Projects page (never expose the platform token to them).
    token: isPlatform && showToken ? config.ingestToken : "",
    tokenGated: isPlatform && !!settingsKey && !showToken,
    health,
    retention: { logs: "7 days hot (Loki)", metrics: "14 days (VictoriaMetrics)", traces: "in-memory, ~20k (Jaeger)" },
  });
}

function HealthRow({ name, up, note }: { name: string; up: boolean; note: string }) {
  return (
    <li className="flex items-center gap-3 px-4 py-2.5">
      {up ? <CheckCircle2 className="h-4 w-4 text-ok" /> : <XCircle className="h-4 w-4 text-err" />}
      <span className="font-medium">{name}</span>
      <span className="text-2xs text-faint">{note}</span>
      <span className={cn("ml-auto text-2xs font-medium", up ? "text-ok" : "text-err")}>{up ? "reachable" : "unreachable"}</span>
    </li>
  );
}

function CodeBlock({ children }: { children: string }) {
  return (
    <pre className="overflow-x-auto scroll-thin rounded-lg border border-border bg-surface-2 px-3.5 py-3 font-mono text-2xs leading-relaxed text-fg/90">
      {children}
    </pre>
  );
}

export default function Settings() {
  const d = useLoaderData<typeof loader>();
  const tok = d.token || "<INGEST_TOKEN>";

  const agentCmd = `curl -fsSL ${d.publicUrl}/install.sh | sh -s -- \\
  --token ${tok} \\
  --name $(hostname)`;

  const otlpEnv = `# add to any OpenTelemetry-instrumented app
OTEL_EXPORTER_OTLP_ENDPOINT=${d.publicUrl}/otlp
OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
OTEL_EXPORTER_OTLP_HEADERS=Authorization=Bearer ${tok}
OTEL_SERVICE_NAME=<your-service>`;

  return (
    <div className="space-y-5 animate-fade-in">
      <PageTitle title="Settings" sub="Connect more sources, check backend health, and see retention. Everything backwork ingests is real host telemetry." />

      <Card>
        <CardHead title="Backend health" sub="the storage + collection layer" />
        <Deferred resolve={d.health} fallback={<RowsSkeleton rows={5} />}>
          {(h) => (
            <ul className="divide-y divide-border">
              <HealthRow name="Loki" up={h.loki} note="log storage · LogQL" />
              <HealthRow name="VictoriaMetrics" up={h.victoriametrics} note="metrics · PromQL" />
              <HealthRow name="cAdvisor" up={h.cadvisor} note="per-container metrics (scrape target)" />
              <HealthRow name="Vector" up={h.vector} note="log collector (scrape target)" />
              <HealthRow name="Jaeger" up={h.jaeger} note="traces · OTLP" />
            </ul>
          )}
        </Deferred>
      </Card>

      {d.isPlatform ? (
        <div className="grid gap-4 lg:grid-cols-2">
          <Card>
            <CardHead title="Ship logs from another server" sub="one command installs a Vector agent" />
            <div className="space-y-2 p-4">
              <CodeBlock>{agentCmd}</CodeBlock>
              <p className="text-2xs text-faint">Runs a Vector container that forwards the host's container logs to backwork, tagged with the host name. View them under Logs.</p>
            </div>
          </Card>
          <Card>
            <CardHead title="Send traces from an app" sub="OpenTelemetry over OTLP" />
            <div className="space-y-2 p-4">
              <CodeBlock>{otlpEnv}</CodeBlock>
              <p className="text-2xs text-faint">Any OTel SDK works. Spans show up under Traces, Requests and Metrics → Application performance.</p>
            </div>
          </Card>
        </div>
      ) : (
        <Card>
          <CardHead title="Connect a source" sub="ship logs & traces from your own infrastructure" />
          <div className="p-4 text-[13px] text-muted">
            Create a <Link to="/projects" className="font-medium text-brand hover:underline">project</Link> to get an ingest token, then use the install + OpenTelemetry snippets shown there. Your data is isolated to this organization.
          </div>
        </Card>
      )}

      <Card>
        <CardHead title="Retention" sub="how long data is kept" />
        <ul className="divide-y divide-border text-[13px]">
          <li className="flex items-center justify-between px-4 py-2.5"><span className="text-muted">Logs</span><span className="font-mono">{d.retention.logs}</span></li>
          <li className="flex items-center justify-between px-4 py-2.5"><span className="text-muted">Metrics</span><span className="font-mono">{d.retention.metrics}</span></li>
          <li className="flex items-center justify-between px-4 py-2.5"><span className="text-muted">Traces</span><span className="font-mono">{d.retention.traces}</span></li>
        </ul>
      </Card>

      <div className="rounded-xl border border-warn/30 bg-warn/5 px-4 py-3">
        <div className="flex items-start gap-2.5">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warn" />
          <div className="text-[13px]">
            <p className="font-medium text-warn">This dashboard has no authentication yet.</p>
            <p className="mt-0.5 text-muted">
              Anyone who can reach it can see your logs/metrics and {d.tokenGated ? "request" : "read"} the ingest token above.
              {d.tokenGated
                ? " The token is hidden because SETTINGS_KEY is set — append ?key=… to reveal it."
                : " Put it behind HTTP basic auth (Coolify supports this) or set a SETTINGS_KEY env to hide the token here."}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
