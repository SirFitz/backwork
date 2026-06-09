import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { Link, useLoaderData } from "@remix-run/react";
import { ArrowLeft } from "lucide-react";
import { Badge, Card, CardHeader, Empty } from "~/components/ui";
import * as jaeger from "~/lib/jaeger.server";
import { safe } from "~/lib/config.server";
import { cn, fmtMs } from "~/lib/utils";

const SVC_COLORS = ["#ef5a78", "#58a6ff", "#3fb950", "#d8a657", "#a371f7", "#56d4dd"];

export async function loader({ params }: LoaderFunctionArgs) {
  const id = params.id!;
  const trace = await safe(() => jaeger.getTrace(id), null);
  return json({ id, trace: trace.data, error: trace.error });
}

export default function TraceDetail() {
  const d = useLoaderData<typeof loader>();
  const t = d.trace;
  const services = t ? [...new Set(t.spans.map((s) => s.service))] : [];
  const colorOf = (svc: string) => SVC_COLORS[services.indexOf(svc) % SVC_COLORS.length];

  return (
    <div className="space-y-4">
      <Link to="/traces" className="inline-flex items-center gap-1.5 text-sm text-muted hover:text-fg">
        <ArrowLeft className="h-4 w-4" /> Back to traces
      </Link>

      {!t ? (
        <Card><Empty>Trace not found{d.error ? ` — ${d.error}` : ""}.</Empty></Card>
      ) : (
        <Card>
          <CardHeader
            title={<span className="font-mono">{t.spans[0]?.operationName}</span>}
            subtitle={<span className="font-mono text-[11px]">{d.id}</span>}
            right={<div className="flex items-center gap-2 text-xs text-muted">{t.spans.length} spans · <span className="font-mono">{fmtMs(t.durationMs)}</span></div>}
          />
          <div className="flex flex-wrap gap-1.5 px-4 py-2">
            {services.map((s) => (
              <span key={s} className="inline-flex items-center gap-1.5 text-xs text-muted">
                <span className="h-2 w-2 rounded-full" style={{ background: colorOf(s) }} />
                {s}
              </span>
            ))}
          </div>
          <div className="space-y-0.5 p-3 font-mono text-xs">
            {t.spans.map((s) => {
              const offsetPct = t.durationMs > 0 ? ((s.startMs - t.startMs) / t.durationMs) * 100 : 0;
              const widthPct = t.durationMs > 0 ? Math.max(0.5, (s.durationMs / t.durationMs) * 100) : 1;
              return (
                <div key={s.spanID} className="flex items-center gap-2 rounded px-1 py-1 hover:bg-panel-2/40">
                  <div className="w-[38%] truncate" style={{ paddingLeft: s.depth * 14 }}>
                    {s.error ? <Badge tone="err" className="mr-1.5">!</Badge> : null}
                    <span className="text-accent">{s.service}</span>
                    <span className="text-muted"> · </span>
                    <span className="text-fg/90">{s.operationName}</span>
                  </div>
                  <div className="relative h-4 flex-1 rounded bg-panel-2/60">
                    <div
                      className={cn("absolute top-0 h-4 rounded", s.error && "ring-1 ring-err")}
                      style={{ left: `${offsetPct}%`, width: `${widthPct}%`, background: colorOf(s.service) }}
                      title={`${s.operationName} · ${fmtMs(s.durationMs)}`}
                    />
                  </div>
                  <div className="w-16 shrink-0 text-right tabular-nums text-muted">{fmtMs(s.durationMs)}</div>
                </div>
              );
            })}
          </div>
        </Card>
      )}
    </div>
  );
}
