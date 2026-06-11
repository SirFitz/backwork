import { config, fetchJson } from "./config.server";
import { cached } from "./cache.server";
import type { Tenant } from "./tenant.server";

/** Inject an org_id matcher into EVERY LogQL stream selector for non-platform
 *  tenants — not just the first. A LogQL query can carry multiple `{...}`
 *  selectors (binary ops, e.g. `{a} or {b}`), and raw user queries / alert-rule
 *  service fields are passed through; scoping only the first selector let a
 *  customer read another tenant's logs via the second. Walks the string
 *  quote-aware so braces inside line-filter strings (`|~ "(?i){x}"`) are ignored.
 *  Platform (and untenanted internal calls) are left unfiltered. */
function scoped(query: string, t?: Tenant): string {
  if (!t || t.platform) return query;
  const m = `org_id=${JSON.stringify(t.orgId)}`;
  let out = "";
  let i = 0;
  let inStr = false;
  while (i < query.length) {
    const c = query[i];
    if (inStr) {
      out += c;
      if (c === "\\" && i + 1 < query.length) { out += query[i + 1]; i += 2; continue; }
      if (c === '"') inStr = false;
      i++;
      continue;
    }
    if (c === '"') { inStr = true; out += c; i++; continue; }
    if (c === "{") {
      let j = i + 1;
      let s = false;
      while (j < query.length) {
        const d = query[j];
        if (s) { if (d === "\\") { j += 2; continue; } if (d === '"') s = false; j++; continue; }
        if (d === '"') { s = true; j++; continue; }
        if (d === "}") break;
        j++;
      }
      const inner = query.slice(i + 1, j).trim();
      out += "{" + (inner ? `${m},${inner}` : m) + "}";
      i = j + 1;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

export type LogEntry = {
  ts: number; // ms
  line: string;
  labels: Record<string, string>;
  level: string;
  service: string;
  message: string;
};

type LokiStreamResult = {
  status: string;
  data: {
    resultType: string;
    result: Array<{ stream: Record<string, string>; values: [string, string][] }>;
  };
};

type LokiMatrixResult = {
  status: string;
  data: {
    resultType: string;
    result: Array<{ metric: Record<string, string>; values: [number, string][] }>;
  };
};

function parseLine(raw: string): { level?: string; message?: string } {
  try {
    const o = JSON.parse(raw);
    const inner = o.message && typeof o.message === "string" ? safeParse(o.message) : null;
    const src = inner || o;
    return {
      level: src.level ? String(src.level).toLowerCase() : undefined,
      message: src.display || src.msg || src.message || (typeof raw === "string" ? raw : JSON.stringify(o)),
    };
  } catch {
    return { message: raw };
  }
}
function safeParse(s: string): any | null {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

/** Query a LogQL expression over a time range, newest first. */
export async function queryRange(
  query: string,
  opts: { start?: number; end?: number; limit?: number } = {},
  tenant?: Tenant
): Promise<LogEntry[]> {
  const end = opts.end ?? Date.now();
  const start = opts.start ?? end - 60 * 60 * 1000;
  const params = new URLSearchParams({
    query: scoped(query, tenant),
    start: String(start * 1e6), // ns
    end: String(end * 1e6),
    limit: String(opts.limit ?? 200),
    direction: "backward",
  });
  const res = await fetchJson<LokiStreamResult>(
    `${config.lokiUrl}/loki/api/v1/query_range?${params.toString()}`,
    { timeoutMs: 12000, retries: 1 }
  );
  const out: LogEntry[] = [];
  for (const stream of res.data.result || []) {
    for (const [tsNs, line] of stream.values) {
      const parsed = parseLine(line);
      const labels = stream.stream || {};
      out.push({
        ts: Math.floor(Number(tsNs) / 1e6),
        line,
        labels,
        level: parsed.level || labels.level || "info",
        service: labels.service || "unknown",
        message: parsed.message || line,
      });
    }
  }
  out.sort((a, b) => b.ts - a.ts);
  return out;
}

/** Count log lines bucketed over time (for the volume sparkline / rate chart). */
export async function countOverTime(
  query: string,
  opts: { start?: number; end?: number; step?: string } = {},
  tenant?: Tenant
): Promise<Array<{ t: number; v: number; labels: Record<string, string> }>> {
  const end = opts.end ?? Date.now();
  const start = opts.start ?? end - 60 * 60 * 1000;
  const step = opts.step ?? "60s";
  const params = new URLSearchParams({
    query: scoped(query, tenant),
    start: String(Math.floor(start / 1000)),
    end: String(Math.floor(end / 1000)),
    step,
  });
  const res = await fetchJson<LokiMatrixResult>(
    `${config.lokiUrl}/loki/api/v1/query_range?${params.toString()}`,
    { timeoutMs: 12000, retries: 1 }
  );
  const points: Array<{ t: number; v: number; labels: Record<string, string> }> = [];
  for (const series of res.data.result || []) {
    for (const [t, v] of series.values) {
      points.push({ t: t * 1000, v: Number(v), labels: series.metric || {} });
    }
  }
  return points;
}

/** Grouped metric query → { service: latest value }.
 *  Uses query_range, not the instant endpoint: Loki returns nothing for a
 *  grouped `sum by (...)(rate(...))` on the instant API, but works over a range. */
export async function rateByService(query: string, tenant?: Tenant): Promise<Record<string, number>> {
  const end = Date.now();
  const start = end - 10 * 60 * 1000;
  const params = new URLSearchParams({
    query: scoped(query, tenant),
    start: String(Math.floor(start / 1000)),
    end: String(Math.floor(end / 1000)),
    step: "120",
  });
  const res = await fetchJson<{ data: { result: Array<{ metric: Record<string, string>; values: [number, string][] }> } }>(
    `${config.lokiUrl}/loki/api/v1/query_range?${params.toString()}`
  );
  const out: Record<string, number> = {};
  for (const r of res.data.result || []) {
    const k = r.metric.service || "unknown";
    const vals = r.values || [];
    out[k] = vals.length ? Number(vals[vals.length - 1][1]) : 0;
  }
  return out;
}

/** Instant metric query returning a single scalar (sum of vector), or fallback. */
export async function scalar(query: string, fallback = 0, tenant?: Tenant): Promise<number> {
  const res = await fetchJson<{ data: { result: Array<{ value: [number, string] }> } }>(
    `${config.lokiUrl}/loki/api/v1/query?query=${encodeURIComponent(scoped(query, tenant))}`
  );
  const rows = res.data.result || [];
  if (!rows.length) return fallback;
  return rows.reduce((a, r) => a + Number(r.value[1]), 0);
}

export async function labelValues(name: string, tenant?: Tenant): Promise<string[]> {
  let url = `${config.lokiUrl}/loki/api/v1/label/${encodeURIComponent(name)}/values`;
  if (tenant && !tenant.platform) url += `?query=${encodeURIComponent(`{org_id=${JSON.stringify(tenant.orgId)}}`)}`;
  const res = await fetchJson<{ data: string[] }>(url);
  return (res.data || []).sort();
}

export function services(tenant?: Tenant): Promise<string[]> {
  const key = tenant && !tenant.platform ? `loki:services:${tenant.orgId}` : "loki:services";
  return cached(key, 30000, () => labelValues("service", tenant));
}
