import { config } from "../config.server";

// Same-origin, path-only redirect target: prevents open redirects via ?next=.
// Browsers strip tabs and newlines and treat a backslash as a slash, so "/\t/evil.com" or
// "/\\evil.com" would leave the site. Only a single leading "/" followed by a safe character passes.
export function safeRedirect(to: unknown, fallback = "/"): string {
  if (typeof to !== "string" || !to) return fallback;
  let decoded = to;
  try {
    decoded = decodeURIComponent(to);
  } catch {
    return fallback;
  }
  for (const candidate of [to, decoded]) {
    if (/[\u0000-\u001f\u007f-\u009f\\]/.test(candidate)) return fallback;
    if (!/^\/(?![/\\])/.test(candidate)) return fallback;
  }
  try {
    const u = new URL(to, "https://x.invalid");
    if (u.origin !== "https://x.invalid") return fallback;
    return u.pathname + u.search + u.hash;
  } catch {
    return fallback;
  }
}

export function clientIp(request: Request): string {
  const xff = request.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0].trim();
  return request.headers.get("x-real-ip") || request.headers.get("cf-connecting-ip") || "unknown";
}

// In-process sliding-window rate limiter (single server process). Returns ok=false
// once `max` is exceeded within `windowMs`.
type Hit = { count: number; reset: number };
declare global {
  // eslint-disable-next-line no-var
  var __bwRate: Map<string, Hit> | undefined;
}
function store(): Map<string, Hit> {
  if (!globalThis.__bwRate) globalThis.__bwRate = new Map();
  return globalThis.__bwRate;
}
export function rateLimit(key: string, max: number, windowMs: number): { ok: boolean; retryAfter: number } {
  const now = Date.now();
  const m = store();
  const h = m.get(key);
  if (!h || now > h.reset) {
    m.set(key, { count: 1, reset: now + windowMs });
    return { ok: true, retryAfter: 0 };
  }
  h.count++;
  if (h.count > max) return { ok: false, retryAfter: Math.ceil((h.reset - now) / 1000) };
  return { ok: true, retryAfter: 0 };
}

// CSRF defense: a state-changing request that carries a browser Origin must match
// our own host. Requests without an Origin (server-to-server agents, curl) are
// left to token/credential auth + rate limiting.
export function assertSameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  if (!origin) return;
  let originHost = "";
  try {
    originHost = new URL(origin).hostname;
  } catch {
    throw new Response("bad origin", { status: 403 });
  }
  const allowed = new Set<string>();
  try {
    allowed.add(new URL(config.publicUrl).hostname);
  } catch {
    /* ignore */
  }
  const host = request.headers.get("host");
  if (host) allowed.add(host.split(":")[0]);
  const xfh = request.headers.get("x-forwarded-host");
  if (xfh) allowed.add(xfh.split(",")[0].trim().split(":")[0]);
  if (!allowed.has(originHost)) throw new Response("cross-origin request blocked", { status: 403 });
}
