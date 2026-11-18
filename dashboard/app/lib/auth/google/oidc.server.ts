import { createHash, randomBytes } from "node:crypto";
import { GoogleAuthError, GoogleErrorCode, type GoogleIdentity } from "./types";
import { verifyIdToken, type Jwk } from "./token.server";

export interface GoogleOidcSettings {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  authUrl: string;
  tokenUrl: string;
  jwksUrl: string;
}

/** Fetch is passed in so tests can stand in for Google. */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface AuthRequestSecrets {
  state: string;
  nonce: string;
  verifier: string;
}

const REQUEST_TIMEOUT_MS = 10_000;
const JWKS_TTL_MS = 60 * 60 * 1000;

function b64url(buf: Buffer): string {
  return buf.toString("base64url");
}

export function newAuthRequestSecrets(): AuthRequestSecrets {
  return { state: b64url(randomBytes(24)), nonce: b64url(randomBytes(24)), verifier: b64url(randomBytes(48)) };
}

export function pkceChallenge(verifier: string): string {
  return b64url(createHash("sha256").update(verifier).digest());
}

/** The Google consent URL. Scopes openid email profile; always asks which account. */
export function buildAuthorizationUrl(settings: GoogleOidcSettings, secrets: AuthRequestSecrets): string {
  const u = new URL(settings.authUrl);
  u.searchParams.set("client_id", settings.clientId);
  u.searchParams.set("redirect_uri", settings.redirectUri);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope", "openid email profile");
  u.searchParams.set("state", secrets.state);
  u.searchParams.set("nonce", secrets.nonce);
  u.searchParams.set("code_challenge", pkceChallenge(secrets.verifier));
  u.searchParams.set("code_challenge_method", "S256");
  u.searchParams.set("prompt", "select_account");
  return u.toString();
}

async function timedFetch(fetcher: FetchLike, url: string, init: RequestInit = {}): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetcher(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

/** Swap the one-time code for an ID token, server to server. */
export async function exchangeCode(settings: GoogleOidcSettings, code: string, verifier: string, fetcher: FetchLike): Promise<string> {
  let res: Response;
  try {
    res = await timedFetch(fetcher, settings.tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        client_id: settings.clientId,
        client_secret: settings.clientSecret,
        redirect_uri: settings.redirectUri,
        code_verifier: verifier,
      }),
    });
  } catch {
    throw new GoogleAuthError(GoogleErrorCode.ExchangeFailed, "token endpoint unreachable");
  }
  if (!res.ok) throw new GoogleAuthError(GoogleErrorCode.ExchangeFailed, `token endpoint ${res.status}`);
  const body = (await res.json().catch(() => null)) as { id_token?: unknown } | null;
  if (!body || typeof body.id_token !== "string" || !body.id_token) throw new GoogleAuthError(GoogleErrorCode.ExchangeFailed, "no id_token");
  return body.id_token;
}

interface JwksCache {
  url: string;
  keys: Jwk[];
  fetchedAt: number;
}
let jwksCache: JwksCache | null = null;

/** Google's signing keys, cached for an hour and refetched once when a token names an unknown key. */
export async function loadKeys(url: string, fetcher: FetchLike, opts: { force?: boolean; now?: number } = {}): Promise<Jwk[]> {
  const now = opts.now ?? Date.now();
  if (!opts.force && jwksCache && jwksCache.url === url && now - jwksCache.fetchedAt < JWKS_TTL_MS) return jwksCache.keys;
  let res: Response;
  try {
    res = await timedFetch(fetcher, url, { headers: { accept: "application/json" } });
  } catch {
    throw new GoogleAuthError(GoogleErrorCode.ExchangeFailed, "jwks unreachable");
  }
  if (!res.ok) throw new GoogleAuthError(GoogleErrorCode.ExchangeFailed, `jwks ${res.status}`);
  const body = (await res.json().catch(() => null)) as { keys?: Jwk[] } | null;
  if (!body || !Array.isArray(body.keys)) throw new GoogleAuthError(GoogleErrorCode.ExchangeFailed, "jwks body");
  jwksCache = { url, keys: body.keys, fetchedAt: now };
  return body.keys;
}

export function clearKeyCache(): void {
  jwksCache = null;
}

function kidOf(idToken: string): string | undefined {
  try {
    return (JSON.parse(Buffer.from(idToken.split(".")[0] ?? "", "base64url").toString("utf8")) as { kid?: string }).kid;
  } catch {
    return undefined;
  }
}

/** Exchange the code, then verify the ID token against Google's keys (iss, aud, exp, nonce, email_verified). */
export async function completeAuthorization(
  settings: GoogleOidcSettings,
  input: { code: string; verifier: string; nonce: string },
  fetcher: FetchLike,
  now: Date = new Date(),
): Promise<GoogleIdentity> {
  const idToken = await exchangeCode(settings, input.code, input.verifier, fetcher);
  let keys = await loadKeys(settings.jwksUrl, fetcher, { now: now.getTime() });
  const kid = kidOf(idToken);
  if (kid && !keys.some((k) => k.kid === kid)) keys = await loadKeys(settings.jwksUrl, fetcher, { force: true, now: now.getTime() });
  return verifyIdToken(idToken, { clientId: settings.clientId, nonce: input.nonce, keys, now });
}
