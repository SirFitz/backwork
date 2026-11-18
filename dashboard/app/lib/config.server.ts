export const config = {
  // Query suggestions (BAC-93): the model an AI write-up would use. No key is configured and the
  // feature is off by default; see lib/hops/suggest-ai.server.ts.
  suggestAiModel: process.env.SUGGEST_AI_MODEL || "claude-sonnet-5-5",
  lokiUrl: process.env.LOKI_URL || "http://loki:3100",
  vmUrl: process.env.VM_URL || "http://victoriametrics:8428",
  // The stack collector's records input (BAC-96, RECORDS_INTAKE in lib/agent/vector-config.server.ts).
  recordsCollectorUrl: process.env.RECORDS_COLLECTOR_URL || "http://vector:8687/records",
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

const GOOGLE_DEFAULTS = {
  authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
  tokenUrl: "https://oauth2.googleapis.com/token",
  jwksUrl: "https://www.googleapis.com/oauth2/v3/certs",
} as const;

/** The auth, token and key URLs can be pointed at a local fake provider, but only outside production
 *  (or when GOOGLE_SIGNIN_TEST_ENDPOINTS=1 is set on purpose, for the local compose stack). */
function googleEndpointOverridesAllowed(): boolean {
  return process.env.NODE_ENV !== "production" || process.env.GOOGLE_SIGNIN_TEST_ENDPOINTS === "1";
}

export interface GoogleAuthSettings {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  authUrl: string;
  tokenUrl: string;
  jwksUrl: string;
}

/** Sign in with Google (BAC-101). Read on each call so tests and a restart-free env change both work. */
export function googleAuthSettings(): GoogleAuthSettings {
  const override = googleEndpointOverridesAllowed();
  const pick = (name: string, fallback: string): string => (override && process.env[name]) || fallback;
  const base = (process.env.PUBLIC_URL || "https://backwork.dev").replace(/\/+$/, "");
  return {
    clientId: process.env.GOOGLE_SIGNIN_CLIENT_ID || "",
    clientSecret: process.env.GOOGLE_SIGNIN_CLIENT_SECRET || "",
    redirectUri: process.env.GOOGLE_SIGNIN_REDIRECT_URI || `${base}/auth/google/callback`,
    authUrl: pick("GOOGLE_SIGNIN_AUTH_URL", GOOGLE_DEFAULTS.authUrl),
    tokenUrl: pick("GOOGLE_SIGNIN_TOKEN_URL", GOOGLE_DEFAULTS.tokenUrl),
    jwksUrl: pick("GOOGLE_SIGNIN_JWKS_URL", GOOGLE_DEFAULTS.jwksUrl),
  };
}

/** The button and the routes exist only when the OAuth client id and secret are set. */
export function googleAuthConfigured(): boolean {
  const s = googleAuthSettings();
  return !!s.clientId && !!s.clientSecret;
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
