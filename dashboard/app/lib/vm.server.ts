import { config, fetchJson } from "./config.server";

type VectorResp = {
  status: string;
  data: { resultType: string; result: Array<{ metric: Record<string, string>; value: [number, string] }> };
};
type MatrixResp = {
  status: string;
  data: { resultType: string; result: Array<{ metric: Record<string, string>; values: [number, string][] }> };
};

export type Series = { metric: Record<string, string>; points: Array<{ t: number; v: number }> };

/** PromQL instant query. */
export async function instant(query: string, time?: number) {
  const params = new URLSearchParams({ query });
  if (time) params.set("time", String(Math.floor(time / 1000)));
  const res = await fetchJson<VectorResp>(`${config.vmUrl}/api/v1/query?${params.toString()}`);
  return (res.data.result || []).map((r) => ({ metric: r.metric, value: Number(r.value[1]) }));
}

/** Single scalar from an instant query (first result), or fallback. */
export async function scalar(query: string, fallback = 0): Promise<number> {
  const r = await instant(query);
  if (!r.length) return fallback;
  const v = r[0].value;
  return Number.isFinite(v) ? v : fallback;
}

/** PromQL range query. */
export async function range(
  query: string,
  opts: { start?: number; end?: number; step?: string } = {}
): Promise<Series[]> {
  const end = opts.end ?? Date.now();
  const start = opts.start ?? end - 60 * 60 * 1000;
  const params = new URLSearchParams({
    query,
    start: String(Math.floor(start / 1000)),
    end: String(Math.floor(end / 1000)),
    step: opts.step ?? "30s",
  });
  const res = await fetchJson<MatrixResp>(`${config.vmUrl}/api/v1/query_range?${params.toString()}`);
  return (res.data.result || []).map((r) => ({
    metric: r.metric,
    points: r.values.map(([t, v]) => ({ t: t * 1000, v: Number(v) })),
  }));
}

/** Which scrape targets are currently up. */
export async function targetsUp(): Promise<Record<string, boolean>> {
  const r = await instant("up");
  const out: Record<string, boolean> = {};
  for (const s of r) {
    const name = s.metric.service || s.metric.job || s.metric.instance || "unknown";
    out[name] = s.value === 1;
  }
  return out;
}
