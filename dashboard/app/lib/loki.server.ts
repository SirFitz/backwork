import { config, fetchJson } from "./config.server";

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
  opts: { start?: number; end?: number; limit?: number } = {}
): Promise<LogEntry[]> {
  const end = opts.end ?? Date.now();
  const start = opts.start ?? end - 60 * 60 * 1000;
  const params = new URLSearchParams({
    query,
    start: String(start * 1e6), // ns
    end: String(end * 1e6),
    limit: String(opts.limit ?? 200),
    direction: "backward",
  });
  const res = await fetchJson<LokiStreamResult>(
    `${config.lokiUrl}/loki/api/v1/query_range?${params.toString()}`,
    { timeoutMs: 22000, retries: 2 }
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
  opts: { start?: number; end?: number; step?: string } = {}
): Promise<Array<{ t: number; v: number; labels: Record<string, string> }>> {
  const end = opts.end ?? Date.now();
  const start = opts.start ?? end - 60 * 60 * 1000;
  const step = opts.step ?? "60s";
  const params = new URLSearchParams({
    query,
    start: String(Math.floor(start / 1000)),
    end: String(Math.floor(end / 1000)),
    step,
  });
  const res = await fetchJson<LokiMatrixResult>(
    `${config.lokiUrl}/loki/api/v1/query_range?${params.toString()}`,
    { timeoutMs: 20000, retries: 2 }
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
export async function rateByService(query: string): Promise<Record<string, number>> {
  const end = Date.now();
  const start = end - 10 * 60 * 1000;
  const params = new URLSearchParams({
    query,
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
export async function scalar(query: string, fallback = 0): Promise<number> {
  const res = await fetchJson<{ data: { result: Array<{ value: [number, string] }> } }>(
    `${config.lokiUrl}/loki/api/v1/query?query=${encodeURIComponent(query)}`
  );
  const rows = res.data.result || [];
  if (!rows.length) return fallback;
  return rows.reduce((a, r) => a + Number(r.value[1]), 0);
}

export async function labelValues(name: string): Promise<string[]> {
  const res = await fetchJson<{ data: string[] }>(
    `${config.lokiUrl}/loki/api/v1/label/${encodeURIComponent(name)}/values`
  );
  return (res.data || []).sort();
}

export async function services(): Promise<string[]> {
  return labelValues("service");
}
