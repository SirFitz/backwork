import { createPublicKey, createVerify, timingSafeEqual } from "node:crypto";
import { GoogleAuthError, GoogleErrorCode, type GoogleIdentity } from "./types";

/** Google's `iss` is one of these two spellings. Never configurable, test endpoints included. */
export const GOOGLE_ISSUERS: readonly string[] = ["https://accounts.google.com", "accounts.google.com"];
const CLOCK_SKEW_SECONDS = 60;

/** An RSA public key as Google publishes it (RFC 7517). */
export interface Jwk {
  kty?: string;
  n?: string;
  e?: string;
  kid?: string;
  alg?: string;
  use?: string;
}

interface JwtHeader {
  alg?: string;
  kid?: string;
}
interface IdTokenClaims {
  iss?: unknown;
  aud?: unknown;
  exp?: unknown;
  iat?: unknown;
  nonce?: unknown;
  sub?: unknown;
  email?: unknown;
  email_verified?: unknown;
  name?: unknown;
  given_name?: unknown;
  hd?: unknown;
}

function decodeSegment<T>(segment: string): T {
  try {
    return JSON.parse(Buffer.from(segment, "base64url").toString("utf8")) as T;
  } catch {
    throw new GoogleAuthError(GoogleErrorCode.TokenInvalid, "malformed token");
  }
}

/** Constant-time string comparison (state, nonce). Different lengths are simply unequal. */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export interface VerifyOptions {
  clientId: string;
  nonce: string;
  keys: readonly Jwk[];
  /** Injected so tests can pin time. */
  now?: Date;
}

/** Check an ID token's signature and claims and return who it proves. Throws GoogleAuthError. */
export function verifyIdToken(idToken: string, opts: VerifyOptions): GoogleIdentity {
  const parts = idToken.split(".");
  if (parts.length !== 3) throw new GoogleAuthError(GoogleErrorCode.TokenInvalid, "not a JWT");
  const [h, p, s] = parts;
  const header = decodeSegment<JwtHeader>(h);
  if (header.alg !== "RS256") throw new GoogleAuthError(GoogleErrorCode.TokenInvalid, "alg");
  const jwk = opts.keys.find((k) => k.kid === header.kid && (!k.alg || k.alg === "RS256"));
  if (!jwk) throw new GoogleAuthError(GoogleErrorCode.TokenInvalid, "unknown key");

  let signatureOk = false;
  try {
    const verifier = createVerify("RSA-SHA256");
    verifier.update(`${h}.${p}`);
    signatureOk = verifier.verify(createPublicKey({ key: jwk, format: "jwk" }), Buffer.from(s, "base64url"));
  } catch {
    signatureOk = false;
  }
  if (!signatureOk) throw new GoogleAuthError(GoogleErrorCode.TokenInvalid, "signature");

  const c = decodeSegment<IdTokenClaims>(p);
  const nowSeconds = Math.floor((opts.now ?? new Date()).getTime() / 1000);
  if (typeof c.iss !== "string" || !GOOGLE_ISSUERS.includes(c.iss)) throw new GoogleAuthError(GoogleErrorCode.TokenInvalid, "iss");
  const audiences = Array.isArray(c.aud) ? c.aud : [c.aud];
  if (!audiences.includes(opts.clientId)) throw new GoogleAuthError(GoogleErrorCode.TokenInvalid, "aud");
  if (typeof c.exp !== "number" || c.exp + CLOCK_SKEW_SECONDS < nowSeconds) throw new GoogleAuthError(GoogleErrorCode.TokenInvalid, "exp");
  if (typeof c.iat === "number" && c.iat - CLOCK_SKEW_SECONDS > nowSeconds) throw new GoogleAuthError(GoogleErrorCode.TokenInvalid, "iat");
  if (typeof c.nonce !== "string" || !safeEqual(c.nonce, opts.nonce)) throw new GoogleAuthError(GoogleErrorCode.TokenInvalid, "nonce");
  if (typeof c.sub !== "string" || !c.sub) throw new GoogleAuthError(GoogleErrorCode.TokenInvalid, "sub");
  if (typeof c.email !== "string" || !c.email.includes("@")) throw new GoogleAuthError(GoogleErrorCode.TokenInvalid, "email");
  if (c.email_verified !== true) throw new GoogleAuthError(GoogleErrorCode.EmailUnverified);

  const email = c.email.trim().toLowerCase();
  const name = typeof c.name === "string" && c.name.trim() ? c.name.trim() : typeof c.given_name === "string" ? c.given_name.trim() : "";
  return { sub: c.sub, email, name, hostedDomain: typeof c.hd === "string" && c.hd ? c.hd : null };
}
