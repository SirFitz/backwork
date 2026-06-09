import * as vm from "./vm.server";
import * as loki from "./loki.server";
import * as docker from "./docker.server";

// cAdvisor groups every metric by container `name`; we carry the friendly labels
// so we can fold per-container metrics up to a per-service view.
const GROUP = "name, container_label_coolify_resourceName, container_label_com_docker_compose_service";

function keyOf(m: Record<string, string>) {
  return m.container_label_coolify_resourceName || m.name || "unknown";
}
function foldByService(rows: { metric: Record<string, string>; value: number }[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of rows) {
    const k = keyOf(r.metric);
    out[k] = (out[k] || 0) + (Number.isFinite(r.value) ? r.value : 0);
  }
  return out;
}

export type ServiceHealth = {
  service: string;
  project: string;
  status: "up" | "degraded" | "down" | "stopped";
  containers: number;
  running: number;
  health: "healthy" | "unhealthy" | "starting" | "none" | "mixed";
  cpuCores: number;
  memBytes: number;
  netRxRate: number;
  netTxRate: number;
  restarts: number;
  oom: number;
  logRate: number;
  errorRate: number;
  reasons: string[];
};

/** Per-service health: Docker state + cAdvisor metrics + Loki log rates. */
export async function serviceHealth(): Promise<ServiceHealth[]> {
  const [containers, cpu, mem, rx, tx, restarts, oom, logRate, errRate] = await Promise.all([
    docker.listContainers().catch(() => [] as docker.ContainerInfo[]),
    vm.instant(`sum by (${GROUP})(rate(container_cpu_usage_seconds_total{name!=""}[5m]))`).catch(() => []),
    vm.instant(`sum by (${GROUP})(container_memory_working_set_bytes{name!=""})`).catch(() => []),
    vm.instant(`sum by (${GROUP})(rate(container_network_receive_bytes_total{name!=""}[5m]))`).catch(() => []),
    vm.instant(`sum by (${GROUP})(rate(container_network_transmit_bytes_total{name!=""}[5m]))`).catch(() => []),
    vm.instant(`sum by (${GROUP})(changes(container_start_time_seconds{name!=""}[1h]))`).catch(() => []),
    vm.instant(`sum by (${GROUP})(increase(container_oom_events_total{name!=""}[6h]))`).catch(() => []),
    loki.rateByService('sum by (service)(rate({service=~".+"}[5m]))').catch(() => ({} as Record<string, number>)),
    loki.rateByService('sum by (service)(rate({level="error"}[5m]))').catch(() => ({} as Record<string, number>)),
  ]);

  const cpuM = foldByService(cpu);
  const memM = foldByService(mem);
  const rxM = foldByService(rx);
  const txM = foldByService(tx);
  const rsM = foldByService(restarts);
  const oomM = foldByService(oom);

  // group docker inventory by service
  const svc = new Map<string, { project: string; total: number; running: number; healths: string[]; crashed: boolean }>();
  for (const c of containers) {
    const e = svc.get(c.service) || { project: c.project, total: 0, running: 0, healths: [], crashed: false };
    e.total++;
    if (c.state === "running") e.running++;
    if (c.crashed) e.crashed = true;
    e.healths.push(c.health);
    svc.set(c.service, e);
  }
  // include services seen only in metrics (e.g. label-only)
  for (const k of [...Object.keys(cpuM), ...Object.keys(memM)]) {
    if (!svc.has(k)) svc.set(k, { project: "", total: 1, running: 1, healths: ["none"], crashed: false });
  }

  const out: ServiceHealth[] = [];
  for (const [service, e] of svc) {
    if (service === "unknown" || service === "") continue;
    const restartN = Math.round(rsM[service] || 0);
    const oomN = Math.round(oomM[service] || 0);
    const errR = errRate[service] || 0;
    const logR = logRate[service] || 0;
    const allRunning = e.running === e.total && e.total > 0;
    const anyUnhealthy = e.healths.includes("unhealthy");
    const health: ServiceHealth["health"] = anyUnhealthy
      ? "unhealthy"
      : e.healths.every((h) => h === "healthy")
      ? "healthy"
      : e.healths.some((h) => h === "healthy")
      ? "mixed"
      : e.healths.includes("starting")
      ? "starting"
      : "none";

    const reasons: string[] = [];
    let status: ServiceHealth["status"] = "up";
    if (e.total > 0 && e.running === 0) {
      // nothing running: a real crash/restart-loop is "down"; otherwise it's
      // just intentionally/long-stopped (neutral, not an incident).
      if (e.crashed) { status = "down"; reasons.push("crashed / restart loop"); }
      else { status = "stopped"; reasons.push("not running"); }
    } else if (!allRunning) {
      status = e.crashed ? "down" : "degraded";
      reasons.push(`${e.total - e.running}/${e.total} containers stopped`);
    }
    if (anyUnhealthy) { status = "down"; reasons.push("healthcheck failing"); }
    if (oomN > 0) { status = "down"; reasons.push(`${oomN} OOM kill${oomN > 1 ? "s" : ""} (6h)`); }
    if (status !== "stopped" && restartN >= 3) { status = status === "up" ? "degraded" : status; reasons.push(`${restartN} restarts (1h)`); }
    if (errR > 0.2 && logR > 0 && errR / logR > 0.1) { status = status === "up" ? "degraded" : status; reasons.push(`${((errR / logR) * 100).toFixed(0)}% error logs`); }

    out.push({
      service,
      project: e.project,
      status,
      containers: e.total,
      running: e.running,
      health,
      cpuCores: cpuM[service] || 0,
      memBytes: memM[service] || 0,
      netRxRate: rxM[service] || 0,
      netTxRate: txM[service] || 0,
      restarts: restartN,
      oom: oomN,
      logRate: logR,
      errorRate: errR,
      reasons,
    });
  }
  // worst first, then busiest; stopped sinks to the bottom
  const rank = { down: 0, degraded: 1, up: 2, stopped: 3 } as const;
  out.sort((a, b) => rank[a.status] - rank[b.status] || b.logRate - a.logRate || a.service.localeCompare(b.service));
  return out;
}

export type Incident = {
  id: string;
  type: "crash" | "oom" | "unhealthy" | "stopped" | "error_spike" | "restart";
  severity: "critical" | "warning";
  service: string;
  title: string;
  detail: string;
  ts: number;
};

export async function getIncidents(): Promise<Incident[]> {
  const health = await serviceHealth().catch(() => [] as ServiceHealth[]);
  const now = Date.now();
  const incidents: Incident[] = [];
  for (const s of health) {
    // intentionally/long stopped services are not incidents
    if (s.status === "stopped") continue;
    if (s.oom > 0)
      incidents.push({ id: `oom-${s.service}`, type: "oom", severity: "critical", service: s.service, title: `${s.service} hit OOM`, detail: `${s.oom} out-of-memory kill(s) in the last 6h.`, ts: now });
    if (s.health === "unhealthy")
      incidents.push({ id: `unhealthy-${s.service}`, type: "unhealthy", severity: "critical", service: s.service, title: `${s.service} healthcheck failing`, detail: `A container is reporting unhealthy.`, ts: now });
    if (s.running === 0 && s.containers > 0 && s.status === "down")
      incidents.push({ id: `crash-${s.service}`, type: "crash", severity: "critical", service: s.service, title: `${s.service} crashed`, detail: `${s.containers} container(s) down after a non-clean exit or restart loop.`, ts: now });
    else if (s.running > 0 && s.running < s.containers && s.status !== "up")
      incidents.push({ id: `partial-${s.service}`, type: "stopped", severity: "warning", service: s.service, title: `${s.service} partially down`, detail: `${s.containers - s.running}/${s.containers} container(s) not running.`, ts: now });
    if (s.restarts >= 3)
      incidents.push({ id: `restart-${s.service}`, type: "restart", severity: s.restarts >= 6 ? "critical" : "warning", service: s.service, title: `${s.service} restart loop`, detail: `${s.restarts} restarts in the last hour.`, ts: now });
    if (s.logRate > 0 && s.errorRate / s.logRate > 0.1 && s.errorRate > 0.2)
      incidents.push({ id: `spike-${s.service}`, type: "error_spike", severity: s.errorRate / s.logRate > 0.3 ? "critical" : "warning", service: s.service, title: `Elevated errors on ${s.service}`, detail: `${((s.errorRate / s.logRate) * 100).toFixed(0)}% of logs are errors (${s.errorRate.toFixed(1)}/s).`, ts: now });
  }
  const rank = { critical: 0, warning: 1 };
  incidents.sort((a, b) => rank[a.severity] - rank[b.severity] || a.service.localeCompare(b.service));
  return incidents;
}

export type HostSummary = {
  containersRunning: number;
  containersTotal: number;
  services: number;
  servicesActive: number;
  servicesDown: number;
  servicesDegraded: number;
  servicesStopped: number;
  cpuCores: number;
  memBytes: number;
  logRate: number;
  errorRate: number;
};

export async function hostSummary(health: ServiceHealth[]): Promise<HostSummary> {
  const containersTotal = health.reduce((a, s) => a + s.containers, 0);
  const running = health.reduce((a, s) => a + s.running, 0);
  const stopped = health.filter((s) => s.status === "stopped").length;
  return {
    containersRunning: running,
    containersTotal,
    services: health.length,
    servicesActive: health.length - stopped,
    servicesDown: health.filter((s) => s.status === "down").length,
    servicesDegraded: health.filter((s) => s.status === "degraded").length,
    servicesStopped: stopped,
    cpuCores: health.reduce((a, s) => a + s.cpuCores, 0),
    memBytes: health.reduce((a, s) => a + s.memBytes, 0),
    logRate: health.reduce((a, s) => a + s.logRate, 0),
    errorRate: health.reduce((a, s) => a + s.errorRate, 0),
  };
}
