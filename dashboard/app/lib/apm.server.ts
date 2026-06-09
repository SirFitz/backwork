import * as jaeger from "./jaeger.server";
import { cached } from "./cache.server";

// RED metrics (Rate, Errors, Duration) derived from real Jaeger traces, for any
// instrumented service. No synthetic data: as more apps emit OTLP spans, more
// services appear here.

export type ServiceAPM = {
  service: string;
  reqRate: number; // req/s
  errorRatePct: number;
  p50: number; // ms
  p95: number;
  p99: number;
  count: number;
};

export type OpRow = {
  service: string;
  op: string;
  reqRate: number;
  p95: number;
  errorRatePct: number;
  count: number;
};

function pct(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[i];
}
// rate from the actual span of returned traces, so it stays correct even when
// the result set is capped by the trace limit.
function rateOf(starts: number[], count: number): number {
  if (count <= 1) return count / 3600;
  const span = (Math.max(...starts) - Math.min(...starts)) / 1000;
  return count / Math.max(span, 1);
}

export type APMResult = {
  byService: ServiceAPM[];
  topOps: OpRow[];
  totals: { reqRate: number; errorRatePct: number; worstP95: number; services: number };
};

export function getAPM(lookbackHours = 1): Promise<APMResult> {
  return cached(`apm:${lookbackHours}`, 12000, () => computeAPM(lookbackHours));
}

async function computeAPM(lookbackHours: number): Promise<APMResult> {
  const services = await jaeger.services().catch(() => [] as string[]);
  const byService: ServiceAPM[] = [];
  const opMap = new Map<string, { service: string; op: string; durs: number[]; errs: number; starts: number[] }>();

  // fetch every service's traces concurrently (was sequential = N round-trips)
  const perService = await Promise.all(
    services.map((svc) =>
      jaeger
        .recentTraces({ service: svc, limit: 150, lookbackHours })
        .then((traces) => ({ svc, traces }))
        .catch(() => ({ svc, traces: [] as jaeger.TraceSummary[] }))
    )
  );

  for (const { svc, traces } of perService) {
    if (!traces.length) continue;
    const durs = traces.map((t) => t.durationMs).sort((a, b) => a - b);
    const starts = traces.map((t) => t.startMs);
    const errs = traces.filter((t) => t.error).length;
    byService.push({
      service: svc,
      reqRate: rateOf(starts, traces.length),
      errorRatePct: (errs / traces.length) * 100,
      p50: pct(durs, 50),
      p95: pct(durs, 95),
      p99: pct(durs, 99),
      count: traces.length,
    });
    for (const t of traces) {
      const key = svc + "|" + t.root;
      const e = opMap.get(key) || { service: svc, op: t.root, durs: [], errs: 0, starts: [] };
      e.durs.push(t.durationMs);
      e.starts.push(t.startMs);
      if (t.error) e.errs++;
      opMap.set(key, e);
    }
  }

  const topOps: OpRow[] = [...opMap.values()]
    .map((e) => ({
      service: e.service,
      op: e.op,
      reqRate: rateOf(e.starts, e.durs.length),
      p95: pct([...e.durs].sort((a, b) => a - b), 95),
      errorRatePct: (e.errs / e.durs.length) * 100,
      count: e.durs.length,
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  byService.sort((a, b) => b.reqRate - a.reqRate);
  const totals = {
    reqRate: byService.reduce((a, s) => a + s.reqRate, 0),
    errorRatePct: byService.length
      ? byService.reduce((a, s) => a + s.errorRatePct * s.count, 0) / byService.reduce((a, s) => a + s.count, 0)
      : 0,
    worstP95: byService.reduce((a, s) => Math.max(a, s.p95), 0),
    services: byService.length,
  };
  return { byService, topOps, totals };
}
