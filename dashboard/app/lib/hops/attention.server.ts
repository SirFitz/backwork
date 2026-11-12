// "What needs attention" on the Overview (design 20): one answer to "is anything slow or failing
// right now, and where", from request data only.
//
// Three checks over the last 15 minutes, each loaded on its own:
//   jumps       services whose error rate or p95 latency rose against the 3 hours before
//               (hop metrics, VictoriaMetrics);
//   stalled     inbound requests and jobs that started more than a minute ago and never
//               finished (hop records, Loki; the same 60-second rule as the request view);
//   unreceived  calls a service made with the hop header sent, that finished, and that no
//               service recorded receiving (the request view's "No record from" gap).
// Health checks are left out (`health.ts`). The rules are pure functions, tested on their own.

import * as loki from "~/lib/loki.server";
import type { Tenant } from "~/lib/tenant.server";
import { cached } from "~/lib/cache.server";
import { parseHopRecord } from "~/lib/hops/parse";
import { STALL_AFTER_MS, isStoreVia } from "~/lib/hops/tree";
import { HopKind, Outcome, type HopId, type HopRecord } from "~/lib/hops/types";
import { JumpKind, LIST_LIMIT, type RecordScan, type ServiceJump, type ServiceWindow, type StalledRequest, type UnreceivedCall } from "~/lib/hops/attention";
export { JumpKind, LIST_LIMIT };
export type { RecordScan, ServiceJump, ServiceWindow, StalledRequest, UnreceivedCall };
import { HopMetric, vmClient, type PromClient } from "~/lib/hops/metrics.server";
import { LOGQL_NOT_HEALTH_CHECK, PROM_NOT_HEALTH_CHECK, isHealthCheckOp } from "~/lib/hops/health";
import { peerPairs } from "~/lib/hops/peers";
import { knownPeersFor, peerStore, type PeerStore } from "~/lib/hops/peers.server";

// ---------------------------------------------------------------- fixed values

/** The window the Overview looks at. */
export const ATTENTION_WINDOW_MS = 15 * 60_000;
const WINDOW = "15m";
/** What "normal" is compared against: the 3 hours before the window. */
const BASELINE = "3h";

/** A service needs this many requests in the window before a jump counts. */
export const MIN_REQUESTS = 10;
/** Error share: at least 5% now, 5 points and twice the baseline. */
export const ERROR_SHARE_FLOOR = 0.05;
/** Error share that counts on its own when the service has no baseline. */
export const ERROR_SHARE_NO_BASELINE = 0.2;
/** p95: at least 1.5 times the baseline and 100 ms slower. */
export const LATENCY_FACTOR = 1.5;
export const LATENCY_MIN_RISE_S = 0.1;

/** A finished call is "never received" only once this long has passed (records still arriving). */
export const RECEIVE_GRACE_MS = 30_000;
/** Lines read per check; the page says when the limit was reached. */
export const RECORD_LIMIT = 3000;


// ---------------------------------------------------------------- jumps (pure)

function share(w: ServiceWindow): number {
  return w.requests > 0 ? Math.min(1, w.failed / w.requests) : 0;
}

/** Services whose error share or p95 rose in the window against the baseline, worst first. */
export function detectJumps(current: readonly ServiceWindow[], baseline: readonly ServiceWindow[]): ServiceJump[] {
  const base = new Map(baseline.map((b) => [b.service, b]));
  const out: ServiceJump[] = [];
  for (const c of current) {
    if (c.requests < MIN_REQUESTS) continue;
    const b = base.get(c.service);
    const hasBase = b !== undefined && b.requests > 0;
    const nowShare = share(c);
    if (hasBase) {
      const was = share(b);
      if (nowShare >= ERROR_SHARE_FLOOR && nowShare >= was + ERROR_SHARE_FLOOR && nowShare >= 2 * was) {
        out.push({ service: c.service, kind: JumpKind.Errors, requests: c.requests, now: nowShare, before: was });
      }
      if (c.p95 !== null && b.p95 !== null && b.p95 > 0 && c.p95 >= LATENCY_FACTOR * b.p95 && c.p95 - b.p95 >= LATENCY_MIN_RISE_S) {
        out.push({ service: c.service, kind: JumpKind.Latency, requests: c.requests, now: c.p95, before: b.p95 });
      }
    } else if (nowShare >= ERROR_SHARE_NO_BASELINE) {
      out.push({ service: c.service, kind: JumpKind.Errors, requests: c.requests, now: nowShare, before: null });
    }
  }
  const severity = (j: ServiceJump): number =>
    j.kind === JumpKind.Errors ? j.now - (j.before ?? 0) : (j.now - (j.before ?? 0)) / Math.max(j.now, 0.001);
  return out.sort((a, b) => severity(b) - severity(a) || a.service.localeCompare(b.service));
}

// ---------------------------------------------------------------- jumps (queries)

const COUNT = `${HopMetric.Duration}_count`;
const BUCKET = `${HopMetric.Duration}_bucket`;

/** The four queries of one window: requests, failed (two disjoint halves), p95. */
export function windowQueries(offset: string | null): { requests: string; errA: string; errB: string; p95: string } {
  const range = offset ? `[${BASELINE}] offset ${offset}` : `[${WINDOW}]`;
  const inbound = `dir="in",${PROM_NOT_HEALTH_CHECK}`;
  return {
    requests: `sum by (service) (increase(${COUNT}{${inbound}}${range}))`,
    errA: `sum by (service) (increase(${COUNT}{${inbound},outcome="error"}${range}))`,
    errB: `sum by (service) (increase(${COUNT}{${inbound},outcome!="error",status_class="5xx"}${range}))`,
    p95: `histogram_quantile(0.95, sum by (service, le) (increase(${BUCKET}{${inbound}}${range})))`,
  };
}

async function readWindow(client: PromClient, tenant: Tenant, offset: string | null): Promise<ServiceWindow[]> {
  const q = windowQueries(offset);
  const [requests, errA, errB, p95] = await Promise.all([
    client.instant(q.requests, tenant),
    client.instant(q.errA, tenant),
    client.instant(q.errB, tenant),
    client.instant(q.p95, tenant),
  ]);
  const by = (rows: Array<{ metric: Record<string, string>; value: number }>): Map<string, number> => {
    const m = new Map<string, number>();
    for (const r of rows) if (Number.isFinite(r.value)) m.set(r.metric.service ?? "", (m.get(r.metric.service ?? "") ?? 0) + r.value);
    return m;
  };
  const a = by(errA);
  const b = by(errB);
  const p = by(p95);
  const out: ServiceWindow[] = [];
  for (const [service, n] of by(requests)) {
    if (!service || n <= 0) continue;
    out.push({ service, requests: n, failed: (a.get(service) ?? 0) + (b.get(service) ?? 0), p95: p.has(service) ? (p.get(service) as number) : null });
  }
  return out;
}

const TTL_MS = 10_000;
const keyOf = (tenant: Tenant, part: string): string => `attention:${tenant.platform ? "platform" : tenant.orgId}:${part}`;

export function serviceJumps(tenant: Tenant, client: PromClient = vmClient): Promise<ServiceJump[]> {
  return cached(keyOf(tenant, "jumps"), TTL_MS, async () => {
    const [current, baseline] = await Promise.all([readWindow(client, tenant, null), readWindow(client, tenant, WINDOW)]);
    return detectJumps(current, baseline);
  });
}

// ---------------------------------------------------------------- stalled and unreceived (pure)

/** Inbound hops started in the window, more than a minute ago, with no end record. Newest first. */
export function findStalled(records: readonly HopRecord[], now: number): StalledRequest[] {
  const ended = new Set<HopId>();
  for (const r of records) if (r.hop === HopKind.InEnd) ended.add(r.hopId);
  const out = new Map<HopId, StalledRequest>();
  for (const r of records) {
    if (r.hop !== HopKind.In || ended.has(r.hopId) || out.has(r.hopId)) continue;
    if (isHealthCheckOp(r.op)) continue;
    if (r.timeMs < now - ATTENTION_WINDOW_MS || now - r.timeMs < STALL_AFTER_MS) continue;
    out.set(r.hopId, { traceId: r.traceId, service: r.service, method: r.method, op: r.op, startMs: r.timeMs });
  }
  return [...out.values()].sort((a, b) => b.startMs - a.startMs);
}

/**
 * Outbound calls (not to a database or cache) that sent the hop header, finished in the window
 * at least RECEIVE_GRACE_MS ago, and whose hop no inbound record names as its parent. Newest first.
 * `inboundFrom` is the oldest time the inbound records cover (when the read hit its limit): a call
 * that started before it cannot be judged, so it is skipped rather than reported.
 */
export function findUnreceived(
  outbound: readonly HopRecord[],
  inbound: readonly HopRecord[],
  now: number,
  inboundFrom: number | null = null
): UnreceivedCall[] {
  const received = new Set<HopId>();
  for (const r of inbound) if (r.parentHop) received.add(r.parentHop);
  const sent = new Set<HopId>();
  for (const r of outbound) if (r.hopSent === true) sent.add(r.hopId);
  const out = new Map<HopId, UnreceivedCall>();
  for (const r of outbound) {
    if (r.hop !== HopKind.OutEnd || isStoreVia(r.via) || out.has(r.hopId)) continue;
    if (!sent.has(r.hopId) || received.has(r.hopId)) continue;
    if (r.timeMs < now - ATTENTION_WINDOW_MS || now - r.timeMs < RECEIVE_GRACE_MS) continue;
    if (inboundFrom !== null && r.timeMs - (r.durationUs ?? 0) / 1000 < inboundFrom) continue;
    out.set(r.hopId, {
      traceId: r.traceId,
      service: r.service,
      peer: r.peer,
      method: r.method,
      op: r.op,
      endMs: r.timeMs,
      failed: r.outcome === Outcome.Error || (r.status !== null && r.status >= 500),
    });
  }
  return [...out.values()].sort((a, b) => b.endMs - a.endMs);
}

export function limitList<T>(rows: readonly T[], truncated: boolean): RecordScan<T> {
  return { rows: rows.slice(0, LIST_LIMIT), total: rows.length, truncated };
}

// ---------------------------------------------------------------- stalled and unreceived (queries)

/** Inbound start and end records, health checks left out. */
export const INBOUND_RECORDS_QUERY = `{kind="hop"} |~ "\\\\bhop\\\\W{1,6}in(?:_end)?(?:\\\\\\\\?\\"|\\\\s|$)" ${LOGQL_NOT_HEALTH_CHECK}`;
/** Outbound start and end records that are not database or cache calls. */
export const OUTBOUND_CALLS_QUERY = `{kind="hop"} |~ "\\\\bhop\\\\W{1,6}out(?:_end)?(?:\\\\\\\\?\\"|\\\\s|$)" !~ "\\\\bvia\\\\W{1,6}(?:db|cache)(?:\\\\\\\\?\\"|\\\\s|$)"`;

export type RecordQueryFn = (query: string, opts: { start: number; end: number; limit: number }, tenant: Tenant) => Promise<loki.LogEntry[]>;

async function readRecords(query: string, tenant: Tenant, now: number, read: RecordQueryFn): Promise<{ records: HopRecord[]; truncated: boolean }> {
  // A little before the window, so a receiver that started before its caller's window is found.
  const entries = await read(query, { start: now - ATTENTION_WINDOW_MS - 5 * 60_000, end: now, limit: RECORD_LIMIT }, tenant);
  const records: HopRecord[] = [];
  for (const e of entries) {
    const r = parseHopRecord({ ts: e.ts, line: e.line, labels: e.labels });
    if (r) records.push(r);
  }
  return { records, truncated: entries.length >= RECORD_LIMIT };
}

/** Inbound records of the window, shared by both checks within one page load. */
function inboundRecords(tenant: Tenant, now: number, read: RecordQueryFn): Promise<{ records: HopRecord[]; truncated: boolean }> {
  return cached(keyOf(tenant, "inbound"), TTL_MS, () => readRecords(INBOUND_RECORDS_QUERY, tenant, now, read));
}

export async function stalledRequests(tenant: Tenant, now = Date.now(), read: RecordQueryFn = loki.queryRange): Promise<RecordScan<StalledRequest>> {
  const { records, truncated } = await inboundRecords(tenant, now, read);
  return limitList(findStalled(records, now), truncated);
}

/** Of the unanswered calls, the ones to a peer known to be a service (design 9); all when unknown. */
export function onlyKnownPeers(calls: readonly UnreceivedCall[], known: ReadonlySet<string> | null): UnreceivedCall[] {
  return known === null ? [...calls] : calls.filter((c) => c.peer !== null && known.has(c.peer));
}

export async function unreceivedCalls(
  tenant: Tenant,
  now = Date.now(),
  read: RecordQueryFn = loki.queryRange,
  peers: PeerStore = peerStore
): Promise<RecordScan<UnreceivedCall>> {
  const [inbound, outbound] = await Promise.all([
    inboundRecords(tenant, now, read),
    cached(keyOf(tenant, "outbound"), TTL_MS, () => readRecords(OUTBOUND_CALLS_QUERY, tenant, now, read)),
  ]);
  const inboundFrom = inbound.truncated && inbound.records.length ? Math.min(...inbound.records.map((r) => r.timeMs)) : null;
  const unanswered = findUnreceived(outbound.records, inbound.records, now, inboundFrom);
  // A call to a host no service has ever answered as is "not instrumented yet", not a problem.
  const all = [...outbound.records, ...inbound.records];
  const known = unanswered.length ? await knownPeersFor(tenant.orgId, peerPairs(all), unanswered.map((c) => c.peer).filter((p): p is string => p !== null), peers) : [];
  return limitList(onlyKnownPeers(unanswered, known === null ? null : new Set(known)), inbound.truncated || outbound.truncated);
}
