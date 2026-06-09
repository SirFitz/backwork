import * as vm from "./vm.server";
import * as loki from "./loki.server";

export type ServiceHealth = {
  service: string;
  status: "up" | "degraded" | "down";
  reqRate: number; // req/s
  errorRatePct: number;
  p95Ms: number;
  p50Ms: number;
  cpuCores: number;
  memMB: number;
  restarts: number;
};

function mapBy(results: { metric: Record<string, string>; value: number }[], key = "service") {
  const m: Record<string, number> = {};
  for (const r of results) {
    const k = r.metric[key];
    if (k) m[k] = r.value;
  }
  return m;
}

/** Per-service health rolled up from VictoriaMetrics. */
export async function serviceHealth(): Promise<ServiceHealth[]> {
  const [up, req, err, p95, p50, cpu, mem, restarts] = await Promise.all([
    vm.instant("up").catch(() => []),
    vm.instant("sum by (service) (rate(http_requests_total[5m]))").catch(() => []),
    vm
      .instant(
        'sum by (service) (rate(http_requests_total{status=~"5.."}[5m])) / clamp_min(sum by (service)(rate(http_requests_total[5m])), 0.001)'
      )
      .catch(() => []),
    vm
      .instant(
        "histogram_quantile(0.95, sum by (service, le)(rate(http_request_duration_seconds_bucket[5m])))"
      )
      .catch(() => []),
    vm
      .instant(
        "histogram_quantile(0.50, sum by (service, le)(rate(http_request_duration_seconds_bucket[5m])))"
      )
      .catch(() => []),
    vm.instant("sum by (service)(rate(process_cpu_seconds_total[5m]))").catch(() => []),
    vm.instant("sum by (service)(process_resident_memory_bytes)").catch(() => []),
    vm.instant("sum by (service)(changes(process_start_time_seconds[3h]))").catch(() => []),
  ]);

  const upm = mapBy(up);
  const reqm = mapBy(req);
  const errm = mapBy(err);
  const p95m = mapBy(p95);
  const p50m = mapBy(p50);
  const cpum = mapBy(cpu);
  const memm = mapBy(mem);
  const rsm = mapBy(restarts);

  const services = new Set<string>([
    ...Object.keys(upm),
    ...Object.keys(reqm),
    ...Object.keys(memm),
  ]);
  // never surface infra targets as "services" on the health board
  for (const infra of ["victoriametrics", "vector"]) services.delete(infra);

  const out: ServiceHealth[] = [];
  for (const s of services) {
    const isUp = upm[s] === undefined ? Object.keys(reqm).includes(s) : upm[s] === 1;
    const errPct = (errm[s] || 0) * 100;
    const p95Ms = (p95m[s] || 0) * 1000;
    let status: ServiceHealth["status"] = "up";
    if (!isUp) status = "down";
    else if (errPct >= 5 || p95Ms >= 1000) status = "degraded";
    out.push({
      service: s,
      status,
      reqRate: reqm[s] || 0,
      errorRatePct: errPct,
      p95Ms,
      p50Ms: (p50m[s] || 0) * 1000,
      cpuCores: cpum[s] || 0,
      memMB: (memm[s] || 0) / 1024 / 1024,
      restarts: Math.round(rsm[s] || 0),
    });
  }
  out.sort((a, b) => a.service.localeCompare(b.service));
  return out;
}

export type Incident = {
  id: string;
  type: "crash" | "error_spike" | "restart";
  severity: "critical" | "warning";
  service: string;
  title: string;
  detail: string;
  ts: number;
  count?: number;
};

/** Detect incidents from logs (crashes) + metrics (restarts, sustained errors). */
export async function getIncidents(lookbackHours = 6): Promise<Incident[]> {
  const end = Date.now();
  const start = end - lookbackHours * 3600 * 1000;
  const incidents: Incident[] = [];

  // 1. fatal / crash log lines
  const fatal = await loki
    .queryRange('{level=~"fatal|error"} |~ "(?i)oom|out of memory|fatal|panic|segfault|killed"', {
      start,
      end,
      limit: 50,
    })
    .catch(() => [] as loki.LogEntry[]);
  const seenCrash = new Set<string>();
  for (const e of fatal) {
    const key = `${e.service}-${Math.floor(e.ts / 60000)}`;
    if (seenCrash.has(key)) continue;
    seenCrash.add(key);
    incidents.push({
      id: `crash-${e.service}-${e.ts}`,
      type: "crash",
      severity: "critical",
      service: e.service,
      title: `${e.service} crashed`,
      detail: e.message.slice(0, 200),
      ts: e.ts,
    });
  }

  // 2. container restarts (process_start_time_seconds changed)
  const restarts = await vm
    .instant("sum by (service)(changes(process_start_time_seconds[" + lookbackHours + "h]))")
    .catch(() => []);
  for (const r of restarts) {
    if (r.value >= 1 && r.metric.service) {
      incidents.push({
        id: `restart-${r.metric.service}`,
        type: "restart",
        severity: "warning",
        service: r.metric.service,
        title: `${r.metric.service} restarted ${Math.round(r.value)}×`,
        detail: `Process start time changed ${Math.round(r.value)} time(s) in the last ${lookbackHours}h.`,
        ts: end,
        count: Math.round(r.value),
      });
    }
  }

  // 3. sustained error spikes
  const spikes = await vm
    .instant(
      'sum by (service) (rate(http_requests_total{status=~"5.."}[5m])) / clamp_min(sum by (service)(rate(http_requests_total[5m])), 0.001) > 0.1'
    )
    .catch(() => []);
  for (const s of spikes) {
    if (s.metric.service) {
      incidents.push({
        id: `spike-${s.metric.service}`,
        type: "error_spike",
        severity: s.value >= 0.25 ? "critical" : "warning",
        service: s.metric.service,
        title: `Elevated error rate on ${s.metric.service}`,
        detail: `5xx error rate is ${(s.value * 100).toFixed(1)}% over the last 5 minutes.`,
        ts: end,
      });
    }
  }

  // de-dup by id, newest first
  const byId = new Map<string, Incident>();
  for (const i of incidents) if (!byId.has(i.id)) byId.set(i.id, i);
  return [...byId.values()].sort((a, b) => b.ts - a.ts);
}

export type Anomaly = {
  service: string;
  metric: string;
  current: number;
  baseline: number;
  deltaPct: number;
};

/** Compare last-5m behaviour to the trailing 1h baseline. */
export async function getAnomalies(): Promise<Anomaly[]> {
  const [errNow, errBase, rateNow, rateBase] = await Promise.all([
    vm.instant('sum by (service)(rate(http_requests_total{status=~"5.."}[5m]))').catch(() => []),
    vm.instant('sum by (service)(rate(http_requests_total{status=~"5.."}[1h]))').catch(() => []),
    vm.instant("sum by (service)(rate(http_requests_total[5m]))").catch(() => []),
    vm.instant("sum by (service)(rate(http_requests_total[1h]))").catch(() => []),
  ]);
  const out: Anomaly[] = [];
  const en = mapBy(errNow), eb = mapBy(errBase);
  for (const s of Object.keys(en)) {
    if (eb[s] > 0.001 && en[s] / eb[s] > 2.5) {
      out.push({ service: s, metric: "error rate", current: en[s], baseline: eb[s], deltaPct: (en[s] / eb[s] - 1) * 100 });
    }
  }
  const rn = mapBy(rateNow), rb = mapBy(rateBase);
  for (const s of Object.keys(rn)) {
    if (rb[s] > 0.1) {
      const ratio = rn[s] / rb[s];
      if (ratio > 2.5 || ratio < 0.3) {
        out.push({ service: s, metric: ratio > 1 ? "traffic surge" : "traffic drop", current: rn[s], baseline: rb[s], deltaPct: (ratio - 1) * 100 });
      }
    }
  }
  return out;
}
