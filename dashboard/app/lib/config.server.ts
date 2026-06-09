export const config = {
  lokiUrl: process.env.LOKI_URL || "http://loki:3100",
  vmUrl: process.env.VM_URL || "http://victoriametrics:8428",
  jaegerUrl: process.env.JAEGER_URL || "http://jaeger:16686",
  dataDir: process.env.DATA_DIR || "/data",
  // bearer token external agents present to the ingest proxy
  ingestToken: process.env.INGEST_TOKEN || "",
  // public base URL, used by the agent install script
  publicUrl: process.env.PUBLIC_URL || "https://backwork.dev",
};

const DEFAULT_TIMEOUT = 8000;

export async function fetchJson<T = any>(
  url: string,
  init?: RequestInit & { timeoutMs?: number }
): Promise<T> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), init?.timeoutMs ?? DEFAULT_TIMEOUT);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`${res.status} ${res.statusText} for ${url} :: ${body.slice(0, 200)}`);
    }
    return (await res.json()) as T;
  } finally {
    clearTimeout(t);
  }
}

/** Run a data fetch and never throw — returns a fallback + the error string so
 *  every panel degrades independently if one backend is down. */
export async function safe<T>(
  fn: () => Promise<T>,
  fallback: T
): Promise<{ data: T; error: string | null }> {
  try {
    return { data: await fn(), error: null };
  } catch (e: any) {
    return { data: fallback, error: e?.message ? String(e.message) : String(e) };
  }
}
