import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { Form, Link, useLoaderData, useNavigate, useSubmit } from "@remix-run/react";
import { GitBranch } from "lucide-react";
import { Badge, Card, CardHead, Empty, ErrorNote, PageTitle } from "~/components/ui";
import * as jaeger from "~/lib/jaeger.server";
import { safe } from "~/lib/config.server";
import { requireOrg } from "~/lib/auth/context.server";
import { tenantOf } from "~/lib/tenant.server";
import { cached } from "~/lib/cache.server";
import { cn, fmtMs, timeAgo } from "~/lib/utils";

const RANGES: Record<string, number> = { "1h": 1, "6h": 6, "24h": 24 };

export async function loader({ request }: LoaderFunctionArgs) {
  const ctx = await requireOrg(request);
  const t = tenantOf(ctx.org.id);
  const url = new URL(request.url);
  const requested = url.searchParams.get("service") || "";
  const rangeKey = url.searchParams.get("range") || "1h";
  const hrs = RANGES[rangeKey] ?? 1;
  // cache so the 10s live-poll doesn't re-query Jaeger every tick (PERF-4)
  const services = await cached(`tr:svcs:${t.orgId}`, 30000, () => safe(() => jaeger.services(t), [] as string[]));
  const chosen = requested || services.data[0] || "";
  const traces = chosen
    ? await cached(`tr:list:${t.orgId}:${chosen}:${rangeKey}`, 8000, () => safe(() => jaeger.recentTraces({ service: chosen, limit: 40, lookbackHours: hrs }, t), [] as jaeger.TraceSummary[]))
    : { data: [] as jaeger.TraceSummary[], error: null as string | null };
  return json({ services: services.data, traces: traces.data, error: traces.error, service: chosen, range: rangeKey });
}

export default function Traces() {
  const d = useLoaderData<typeof loader>();
  const submit = useSubmit();
  const navigate = useNavigate();

  return (
    <div className="space-y-4 animate-fade-in">
      <PageTitle title="Traces" sub="Distributed traces follow a request across services. They appear here when an app emits OpenTelemetry spans." />

      {d.services.length === 0 ? (
        <Card>
          <div className="flex flex-col items-center px-6 py-14 text-center">
            <span className="grid h-11 w-11 place-items-center rounded-xl bg-surface-2 text-faint"><GitBranch className="h-5 w-5" /></span>
            <p className="mt-4 text-sm font-medium">No instrumented services yet</p>
            <p className="mt-1 max-w-[52ch] text-[13px] text-muted">
              Tracing needs apps to emit spans. Point an OpenTelemetry exporter at the bundled
              Jaeger collector (OTLP) and traces will show up here automatically. Logs and metrics
              work for every container without any instrumentation.
            </p>
            <code className="mt-4 rounded-lg border border-border bg-surface-2 px-3 py-1.5 font-mono text-2xs text-muted">
              OTEL_EXPORTER_OTLP_ENDPOINT = http://jaeger:4318
            </code>
          </div>
        </Card>
      ) : (
        <>
          <Form method="get" className="flex flex-wrap items-center gap-2">
            <select
              name="service"
              defaultValue={d.service}
              onChange={(e) => submit(e.currentTarget.form)}
              className="h-9 w-full max-w-full sm:w-auto rounded-lg border border-border bg-surface px-3 text-[13px] outline-none focus:border-brand/40"
            >
              {d.services.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
            <select
              name="range"
              defaultValue={d.range}
              onChange={(e) => submit(e.currentTarget.form)}
              className="h-9 w-full max-w-full sm:w-auto rounded-lg border border-border bg-surface px-3 text-[13px] outline-none focus:border-brand/40"
            >
              {Object.keys(RANGES).map((r) => <option key={r} value={r}>last {r}</option>)}
            </select>
          </Form>

          <Card>
            <CardHead title="Recent traces" sub={`${d.service} · last ${d.range}`} right={<Badge tone="neutral">{d.traces.length}</Badge>} />
            <ErrorNote error={d.error} />
            {d.traces.length >= 40 ? <div className="px-4 pt-2 text-2xs text-faint">Showing the 40 most recent traces from the last {d.range} — pick a service to narrow.</div> : null}
            {d.traces.length === 0 ? (
              <Empty icon={<GitBranch className="h-5 w-5" />} title="No traces in range">Nothing from this service in the last hour.</Empty>
            ) : (
              <div className="overflow-x-auto scroll-thin">
              <table className="w-full text-[13px]">
                <thead>
                  <tr className="border-b border-border text-left text-2xs uppercase tracking-wide text-faint">
                    <th className="px-4 py-2 font-medium">Root operation</th>
                    <th className="px-4 py-2 font-medium">Services</th>
                    <th className="px-4 py-2 text-right font-medium">Spans</th>
                    <th className="px-4 py-2 text-right font-medium">Duration</th>
                    <th className="px-4 py-2 text-right font-medium">When</th>
                  </tr>
                </thead>
                <tbody>
                  {d.traces.map((t) => (
                    <tr key={t.traceID} onClick={() => navigate(`/traces/${t.traceID}`)} className="cursor-pointer border-b border-border/60 last:border-0 hover:bg-surface-2/50">
                      <td className="px-4 py-2.5">
                        <Link to={`/traces/${t.traceID}`} className="font-mono hover:text-brand">
                          {t.error ? <Badge tone="err" className="mr-2">error</Badge> : null}
                          {t.root}
                        </Link>
                      </td>
                      <td className="px-4 py-2.5 text-2xs text-muted">{t.services.join(", ")}</td>
                      <td className="px-4 py-2.5 text-right font-mono tabular-nums text-muted">{t.spans}</td>
                      <td className={cn("px-4 py-2.5 text-right font-mono tabular-nums", t.durationMs >= 1000 ? "text-err" : t.durationMs >= 500 ? "text-warn" : "")}>{fmtMs(t.durationMs)}</td>
                      <td className="px-4 py-2.5 text-right text-2xs text-faint">{timeAgo(t.startMs)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              </div>
            )}
          </Card>
        </>
      )}
    </div>
  );
}
