export const config = {
  lokiUrl: process.env.LOKI_URL || "http://loki:3100",
  vmUrl: process.env.VM_URL || "http://victoriametrics:8428",
  dataDir: process.env.DATA_DIR || "/data",
  // bearer token external agents present to the ingest proxy
  ingestToken: process.env.INGEST_TOKEN || "",
  // public base URL, used by the agent install script
  publicUrl: process.env.PUBLIC_URL || "https://backwork.dev",
  // Billing through Inkress (BAC-57). Off until the keys are set.
  billing: {
    /** Username of the Inkress merchant that sells backwork's plans. */
    merchant: process.env.INKRESS_BILLING_MERCHANT || "backwork",
    /** `live` = api.inkress.com; anything else = the Inkress dev API. */
    mode: process.env.INKRESS_BILLING_API_MODE || "test",
    /** Reads and checkout links. */
    platformKey: process.env.INKRESS_BILLING_PLATFORM_KEY || "",
    /** Merchant-bound key, for plan changes. */
    secretKey: process.env.INKRESS_BILLING_SECRET_KEY || process.env.INKRESS_BILLING_PLATFORM_KEY || "",
    /** The merchant's client secret, which signs webhook tokens. */
    webhookSecret: process.env.INKRESS_BILLING_WEBHOOK_SECRET || "",
  },
};

/** Billing can take payments only when the Inkress keys are set. */
export function billingConfigured(): boolean {
  return !!config.billing.platformKey && !!config.billing.webhookSecret;
}

const DEFAULT_TIMEOUT = 15000;

async function once<T>(url: string, init: (RequestInit & { timeoutMs?: number }) | undefined): Promise<T> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), init?.timeoutMs ?? DEFAULT_TIMEOUT);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`${res.status} ${res.statusText} :: ${body.slice(0, 160)}`);
    }
    return (await res.json()) as T;
  } finally {
    clearTimeout(t);
  }
}

export async function fetchJson<T = any>(
  url: string,
  init?: RequestInit & { timeoutMs?: number; retries?: number }
): Promise<T> {
  const retries = init?.retries ?? 1;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await once<T>(url, init);
    } catch (e) {
      lastErr = e;
      if (attempt < retries) await new Promise((r) => setTimeout(r, 300));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
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
