import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { Form, Link, useLoaderData, useSubmit } from "@remix-run/react";
import { Badge, Card, CardHeader, Empty, ErrorNote } from "~/components/ui";
import * as jaeger from "~/lib/jaeger.server";
import { safe } from "~/lib/config.server";
import { cn, fmtMs, timeAgo } from "~/lib/utils";

export async function loader({ request }: LoaderFunctionArgs) {
  const url = new URL(request.url);
  const requested = url.searchParams.get("service") || "";
  // jaeger's /api/traces requires a service, so resolve one first, then query once.
  const services = await safe(() => jaeger.services(), [] as string[]);
  const chosen = requested || services.data[0] || "";
  const traces = chosen
    ? await safe(() => jaeger.recentTraces({ service: chosen, limit: 40, lookbackHours: 1 }), [] as jaeger.TraceSummary[])
    : { data: [] as jaeger.TraceSummary[], error: null as string | null };
  return json({ services: services.data, traces: traces.data, error: traces.error, service: chosen });
}

export default function Traces() {
  const d = useLoaderData<typeof loader>();
  const submit = useSubmit();
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg font-semibold">Traces</h1>
        <p className="text-sm text-muted">Follow a request as it flows across services — exactly where time is spent.</p>
      </div>

      <Form method="get" onChange={(e) => submit(e.currentTarget)}>
        <select name="service" defaultValue={d.service} className="rounded-md border border-border bg-panel px-3 py-2 text-sm outline-none focus:border-brand/50">
          {d.services.length === 0 ? <option value="">no services</option> : null}
          {d.services.map((s) => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>
      </Form>

      <Card>
        <CardHeader title="Recent traces" subtitle={`${d.service || "—"} · last 1h`} right={<span className="text-xs text-muted">{d.traces.length} traces</span>} />
        <ErrorNote error={d.error} />
        {d.traces.length === 0 ? (
          <Empty>No traces yet. Traces appear once instrumented services emit spans (correlation IDs required).</Empty>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-[11px] uppercase tracking-wide text-muted">
                <th className="px-4 py-2 font-medium">Root operation</th>
                <th className="px-4 py-2 font-medium">Services</th>
                <th className="px-4 py-2 text-right font-medium">Spans</th>
                <th className="px-4 py-2 text-right font-medium">Duration</th>
                <th className="px-4 py-2 text-right font-medium">When</th>
                <th className="px-4 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {d.traces.map((t) => (
                <tr key={t.traceID} className="border-b border-border/40 last:border-0 hover:bg-panel-2/40">
                  <td className="px-4 py-2.5">
                    <Link to={`/traces/${t.traceID}`} className="font-mono text-sm hover:text-brand">
                      {t.error ? <Badge tone="err" className="mr-2">error</Badge> : null}
                      {t.root}
                    </Link>
                  </td>
                  <td className="px-4 py-2.5 text-xs text-muted">{t.services.join(", ")}</td>
                  <td className="px-4 py-2.5 text-right font-mono tabular-nums text-muted">{t.spans}</td>
                  <td className={cn("px-4 py-2.5 text-right font-mono tabular-nums", t.durationMs >= 1000 ? "text-err" : t.durationMs >= 500 ? "text-warn" : "")}>{fmtMs(t.durationMs)}</td>
                  <td className="px-4 py-2.5 text-right text-xs text-muted">{timeAgo(t.startMs)}</td>
                  <td className="px-4 py-2.5 text-right"><Link to={`/traces/${t.traceID}`} className="text-xs text-brand hover:underline">view →</Link></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}
