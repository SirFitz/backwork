// The environment (project) picker (BAC-89): which of an organisation's projects every data page
// reads. Pure and shared by the server (to scope reads) and the browser (to carry the choice on
// links and remember it).

/** The URL search parameter that names the project (its slug), on every data page. */
export const ENV_PARAM = "env";
/** The per-viewer cookie remembering the last environment, per organisation. */
export const ENV_COOKIE = "backwork_env";
/** A year: the remembered choice is a preference, not a session. */
export const ENV_COOKIE_MAX_AGE_S = 365 * 86400;
/** The project picked first when the viewer has no URL value and no remembered one. */
export const DEFAULT_ENV_SLUG = "production";
/** Organisations remembered in the cookie; the oldest drop off past this. */
export const ENV_COOKIE_MAX_ORGS = 20;

/** One project the picker offers. */
export interface EnvOption {
  id: string;
  slug: string;
  name: string;
}

/** Where the chosen environment came from. */
export enum EnvSource {
  Url = "url",
  Cookie = "cookie",
  Production = "production",
  First = "first",
  /** The organisation has no projects: reads stay organisation-wide. */
  None = "none",
}

export interface EnvChoice {
  option: EnvOption | null;
  source: EnvSource;
}

/** Slugs are short, lowercase and URL-safe; anything else in the URL or cookie is ignored. */
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

export function isEnvSlug(v: unknown): v is string {
  return typeof v === "string" && SLUG_RE.test(v);
}

/**
 * The environment to read: the URL's value when it names one of the org's projects, else the
 * remembered one, else `production` when the org has it, else the org's first project.
 * `options` are in creation order.
 */
export function pickEnv(options: readonly EnvOption[], urlValue: string | null | undefined, cookieValue: string | null | undefined): EnvChoice {
  if (!options.length) return { option: null, source: EnvSource.None };
  const bySlug = (slug: string | null | undefined): EnvOption | undefined => (isEnvSlug(slug) ? options.find((o) => o.slug === slug) : undefined);
  const fromUrl = bySlug(urlValue);
  if (fromUrl) return { option: fromUrl, source: EnvSource.Url };
  const fromCookie = bySlug(cookieValue);
  if (fromCookie) return { option: fromCookie, source: EnvSource.Cookie };
  const prod = bySlug(DEFAULT_ENV_SLUG);
  if (prod) return { option: prod, source: EnvSource.Production };
  return { option: options[0], source: EnvSource.First };
}

/** The value of one cookie in a `Cookie` header (or `document.cookie`). */
export function readCookie(header: string | null | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

/** Remembered environments by organisation id. Never throws: a malformed cookie reads as empty. */
export type EnvMemory = Record<string, string>;

export function parseEnvCookie(raw: string | null | undefined): EnvMemory {
  if (!raw) return {};
  try {
    const v: unknown = JSON.parse(decodeURIComponent(raw));
    if (!v || typeof v !== "object" || Array.isArray(v)) return {};
    const out: EnvMemory = {};
    for (const [org, slug] of Object.entries(v as Record<string, unknown>)) {
      if (typeof org === "string" && org.length <= 64 && isEnvSlug(slug)) out[org] = slug;
    }
    return out;
  } catch {
    return {};
  }
}

/** The cookie value with `orgId`'s environment set (moved to the end, so the oldest drop first). */
export function envCookieValue(memory: EnvMemory, orgId: string, slug: string): string {
  const next: EnvMemory = {};
  const others = Object.keys(memory).filter((k) => k !== orgId);
  for (const k of others.slice(Math.max(0, others.length - (ENV_COOKIE_MAX_ORGS - 1)))) next[k] = memory[k];
  next[orgId] = slug;
  return encodeURIComponent(JSON.stringify(next));
}

/**
 * An internal link with the environment carried: `/requests?service=a` + `dev` →
 * `/requests?service=a&env=dev`; a search-only link (`?q=x`) works the same. An `env` already on
 * the link is kept (it is a deliberate choice); external links, protocol-relative ones and other
 * relative values are returned unchanged.
 */
export function withEnv(to: string, env: string | null | undefined): string {
  if (!env || to.startsWith("//") || !(to.startsWith("/") || to.startsWith("?"))) return to;
  const hashAt = to.indexOf("#");
  const hash = hashAt >= 0 ? to.slice(hashAt) : "";
  const rest = hashAt >= 0 ? to.slice(0, hashAt) : to;
  const qAt = rest.indexOf("?");
  const path = qAt >= 0 ? rest.slice(0, qAt) : rest;
  const params = new URLSearchParams(qAt >= 0 ? rest.slice(qAt + 1) : "");
  if (params.has(ENV_PARAM)) return to;
  params.set(ENV_PARAM, env);
  return `${path}?${params.toString()}${hash}`;
}

/** Pages that read telemetry, where the picker is shown. Settings-like pages ignore `env`. */
const DATA_PATH_PREFIXES = ["/requests", "/performance", "/logs", "/insights", "/errors", "/lookup", "/traces"] as const;

export function isDataPath(pathname: string): boolean {
  if (pathname === "/") return true;
  return DATA_PATH_PREFIXES.some((p) => pathname === p || pathname.startsWith(p + "/"));
}
