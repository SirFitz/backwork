import { config, fetchJson } from "./config.server";

export type TraceSummary = {
  traceID: string;
  root: string;
  service: string;
  spans: number;
  services: string[];
  durationMs: number;
  startMs: number;
  error: boolean;
};

export type Span = {
  spanID: string;
  operationName: string;
  service: string;
  startMs: number;
  durationMs: number;
  depth: number;
  error: boolean;
  parentID?: string;
};

export async function services(): Promise<string[]> {
  const res = await fetchJson<{ data: string[] }>(`${config.jaegerUrl}/api/services`);
  return (res.data || []).filter((s) => s && s !== "jaeger-all-in-one").sort();
}

type RawTrace = {
  traceID: string;
  spans: Array<{
    traceID: string;
    spanID: string;
    operationName: string;
    references?: Array<{ refType: string; spanID: string }>;
    startTime: number; // microseconds
    duration: number; // microseconds
    processID: string;
    tags?: Array<{ key: string; value: any }>;
  }>;
  processes: Record<string, { serviceName: string }>;
};

function spanHasError(tags?: Array<{ key: string; value: any }>): boolean {
  if (!tags) return false;
  return tags.some(
    (t) =>
      (t.key === "error" && (t.value === true || t.value === "true")) ||
      (t.key === "http.status_code" && Number(t.value) >= 500) ||
      (t.key === "otel.status_code" && String(t.value).toUpperCase() === "ERROR")
  );
}

export async function recentTraces(
  opts: { service?: string; limit?: number; lookbackHours?: number } = {}
): Promise<TraceSummary[]> {
  const lookback = (opts.lookbackHours ?? 1) * 3600 * 1e6; // micros
  const end = Date.now() * 1000;
  const params = new URLSearchParams({
    limit: String(opts.limit ?? 30),
    lookback: `${opts.lookbackHours ?? 1}h`,
    start: String(end - lookback),
    end: String(end),
  });
  if (opts.service) params.set("service", opts.service);
  const res = await fetchJson<{ data: RawTrace[] }>(
    `${config.jaegerUrl}/api/traces?${params.toString()}`
  );
  const out: TraceSummary[] = [];
  for (const tr of res.data || []) {
    if (!tr.spans?.length) continue;
    const svcSet = new Set<string>();
    let minStart = Infinity;
    let maxEnd = -Infinity;
    let rootSpan = tr.spans[0];
    let anyError = false;
    for (const s of tr.spans) {
      const svc = tr.processes[s.processID]?.serviceName || "unknown";
      svcSet.add(svc);
      minStart = Math.min(minStart, s.startTime);
      maxEnd = Math.max(maxEnd, s.startTime + s.duration);
      if (spanHasError(s.tags)) anyError = true;
      const isRoot = !s.references || s.references.length === 0;
      if (isRoot) rootSpan = s;
    }
    out.push({
      traceID: tr.traceID,
      root: rootSpan.operationName,
      service: tr.processes[rootSpan.processID]?.serviceName || "unknown",
      spans: tr.spans.length,
      services: [...svcSet],
      durationMs: (maxEnd - minStart) / 1000,
      startMs: minStart / 1000,
      error: anyError,
    });
  }
  out.sort((a, b) => b.startMs - a.startMs);
  return out;
}

export async function getTrace(id: string): Promise<{ spans: Span[]; durationMs: number; startMs: number } | null> {
  const res = await fetchJson<{ data: RawTrace[] }>(`${config.jaegerUrl}/api/traces/${encodeURIComponent(id)}`);
  const tr = res.data?.[0];
  if (!tr) return null;
  const byId: Record<string, RawTrace["spans"][number]> = {};
  for (const s of tr.spans) byId[s.spanID] = s;
  let minStart = Infinity;
  let maxEnd = -Infinity;
  for (const s of tr.spans) {
    minStart = Math.min(minStart, s.startTime);
    maxEnd = Math.max(maxEnd, s.startTime + s.duration);
  }
  function depthOf(s: RawTrace["spans"][number]): number {
    let d = 0;
    let cur = s;
    const seen = new Set<string>();
    while (cur.references && cur.references.length && !seen.has(cur.spanID)) {
      seen.add(cur.spanID);
      const parent = byId[cur.references[0].spanID];
      if (!parent) break;
      d++;
      cur = parent;
    }
    return d;
  }
  const spans: Span[] = tr.spans
    .map((s) => ({
      spanID: s.spanID,
      operationName: s.operationName,
      service: tr.processes[s.processID]?.serviceName || "unknown",
      startMs: s.startTime / 1000,
      durationMs: s.duration / 1000,
      depth: depthOf(s),
      error: spanHasError(s.tags),
      parentID: s.references?.[0]?.spanID,
    }))
    .sort((a, b) => a.startMs - b.startMs);
  return { spans, durationMs: (maxEnd - minStart) / 1000, startMs: minStart / 1000 };
}

export async function dependencies(lookbackHours = 24): Promise<Array<{ parent: string; child: string; callCount: number }>> {
  const end = Date.now();
  const params = new URLSearchParams({
    endTs: String(end),
    lookback: String(lookbackHours * 3600 * 1000),
  });
  const res = await fetchJson<{ data: Array<{ parent: string; child: string; callCount: number }> }>(
    `${config.jaegerUrl}/api/dependencies?${params.toString()}`
  );
  return res.data || [];
}
