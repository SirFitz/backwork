import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { Link, useLoaderData } from "@remix-run/react";
import { ArrowLeft } from "lucide-react";
import { Badge, Card, CardHead, Empty } from "~/components/ui";
import { PALETTE } from "~/components/charts";
import * as jaeger from "~/lib/jaeger.server";
import { safe } from "~/lib/config.server";
import { cn, fmtMs } from "~/lib/utils";

export async function loader({ params }: LoaderFunctionArgs) {
  const id = params.id!;
  const trace = await safe(() => jaeger.getTrace(id), null);
  return json({ id, trace: trace.data, error: trace.error });
}

export default function TraceDetail() {
  const d = useLoaderData<typeof loader>();
  const t = d.trace;
  const services = t ? [...new Set(t.spans.map((s) => s.service))] : [];
  const colorOf = (svc: string) => PALETTE[services.indexOf(svc) % PALETTE.length];

  return (
    <div className="space-y-4 animate-fade-in">
      <Link to="/traces" className="inline-flex items-center gap-1.5 text-[13px] text-muted hover:text-fg">
        <ArrowLeft className="h-4 w-4" /> Back to traces
      </Link>

      {!t ? (
        <Card><Empty title="Trace not found">{d.error || "This trace may have aged out of memory storage."}</Empty></Card>
      ) : (
        <Card>
          <CardHead
            title={<span className="font-mono">{t.spans[0]?.operationName}</span>}
            sub={<span className="font-mono">{d.id}</span>}
            right={<span className="text-2xs text-muted">{t.spans.length} spans · <span className="font-mono">{fmtMs(t.durationMs)}</span></span>}
          />
          <div className="flex flex-wrap gap-3 border-b border-border px-4 py-2.5">
            {services.map((s) => (
              <span key={s} className="inline-flex items-center gap-1.5 text-2xs text-muted">
                <span className="h-2 w-2 rounded-full" style={{ background: colorOf(s) }} />
                {s}
              </span>
            ))}
          </div>
          <div className="space-y-0.5 p-3 font-mono text-2xs">
            {t.spans.map((s) => {
              const offset = t.durationMs > 0 ? ((s.startMs - t.startMs) / t.durationMs) * 100 : 0;
              const width = t.durationMs > 0 ? Math.max(0.5, (s.durationMs / t.durationMs) * 100) : 1;
              return (
                <div key={s.spanID} className="flex items-center gap-2 rounded px-1 py-1 hover:bg-surface-2/50">
                  <div className="w-[38%] truncate" style={{ paddingLeft: s.depth * 14 }}>
                    {s.error ? <Badge tone="err" className="mr-1.5">!</Badge> : null}
                    <span className="text-accent">{s.service}</span>
                    <span className="text-faint"> · </span>
                    <span className="text-fg/90">{s.operationName}</span>
                  </div>
                  <div className="relative h-4 flex-1 rounded bg-surface-2">
                    <div className={cn("absolute top-0 h-4 rounded", s.error && "ring-1 ring-err")} style={{ left: `${offset}%`, width: `${width}%`, background: colorOf(s.service) }} title={`${s.operationName} · ${fmtMs(s.durationMs)}`} />
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
