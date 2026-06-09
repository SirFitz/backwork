import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { Form, Link, useLoaderData, useSubmit } from "@remix-run/react";
import { Network } from "lucide-react";
import { Badge, Card, CardHead, Empty, ErrorNote, PageTitle } from "~/components/ui";
import * as jaeger from "~/lib/jaeger.server";
import { safe } from "~/lib/config.server";
import { cn, fmtClock, fmtMs } from "~/lib/utils";

export async function loader({ request }: LoaderFunctionArgs) {
  const requested = new URL(request.url).searchParams.get("service") || "";
  const services = await safe(() => jaeger.services(), [] as string[]);
  const chosen = requested || services.data[0] || "";
  const rows = chosen
    ? await safe(() => jaeger.recentRequests({ service: chosen, limit: 80, lookbackHours: 1 }), [] as jaeger.RequestRow[])
    : { data: [] as jaeger.RequestRow[], error: null as string | null };
  return json({ services: services.data, rows: rows.data, error: rows.error, service: chosen });
}

function statusTone(s: number | null) {
  if (s === null) return "text-muted";
  if (s >= 500) return "text-err";
  if (s >= 400) return "text-warn";
  if (s >= 300) return "text-info";
  return "text-ok";
}

export default function Requests() {
  const d = useLoaderData<typeof loader>();
  const submit = useSubmit();

  return (
    <div className="space-y-4 animate-fade-in">
      <PageTitle title="Requests" sub="A live feed of individual HTTP requests across instrumented services — method, route, status and latency, pulled from traces." />

      {d.services.length === 0 ? (
        <Card>
          <div className="flex flex-col items-center px-6 py-14 text-center">
            <span className="grid h-11 w-11 place-items-center rounded-xl bg-surface-2 text-faint"><Network className="h-5 w-5" /></span>
            <p className="mt-4 text-sm font-medium">No instrumented services yet</p>
            <p className="mt-1 max-w-[52ch] text-[13px] text-muted">Requests appear here once an app emits OpenTelemetry HTTP spans. Point an OTLP exporter at backwork to populate this.</p>
          </div>
        </Card>
      ) : (
        <>
          <Form method="get">
            <select name="service" defaultValue={d.service} onChange={(e) => submit(e.currentTarget.form)} className="h-9 rounded-lg border border-border bg-surface px-3 text-[13px] outline-none focus:border-brand/40">
              {d.services.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </Form>

          <Card>
            <CardHead title="Recent requests" sub={`${d.service} · last 1h`} right={<Badge tone="neutral">{d.rows.length}</Badge>} />
            <ErrorNote error={d.error} />
            {d.rows.length === 0 ? (
              <Empty title="No requests in range">Nothing from this service in the last hour.</Empty>
            ) : (
              <div className="max-h-[68vh] overflow-auto scroll-thin">
                <table className="w-full text-[13px]">
                  <thead className="sticky top-0 bg-surface">
                    <tr className="border-b border-border text-left text-2xs uppercase tracking-wide text-faint">
                      <th className="px-4 py-2 font-medium">Time</th>
                      <th className="px-4 py-2 font-medium">Method</th>
                      <th className="px-4 py-2 font-medium">Route</th>
                      <th className="px-4 py-2 text-right font-medium">Status</th>
                      <th className="px-4 py-2 text-right font-medium">Latency</th>
                      <th className="px-4 py-2"></th>
                    </tr>
                  </thead>
                  <tbody className="font-mono">
                    {d.rows.map((r) => (
                      <tr key={r.traceID} className="border-b border-border/40 last:border-0 hover:bg-surface-2/50">
                        <td className="px-4 py-1.5 tabular-nums text-faint">{fmtClock(r.startMs)}</td>
                        <td className="px-4 py-1.5 font-semibold text-muted">{r.method || "—"}</td>
                        <td className="max-w-[420px] truncate px-4 py-1.5 text-fg/90">{r.route}</td>
                        <td className={cn("px-4 py-1.5 text-right font-semibold tabular-nums", statusTone(r.status))}>{r.status ?? "—"}</td>
                        <td className={cn("px-4 py-1.5 text-right tabular-nums", r.durationMs >= 1000 ? "text-err" : r.durationMs >= 500 ? "text-warn" : "text-muted")}>{fmtMs(r.durationMs)}</td>
                        <td className="px-4 py-1.5 text-right"><Link to={`/traces/${r.traceID}`} className="text-2xs text-brand hover:underline">trace</Link></td>
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
