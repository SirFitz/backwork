// Verifies the HS256 token Inkress signs every webhook with (the merchant's client secret).
import { createHmac, timingSafeEqual } from "node:crypto";

function b64url(buf: Buffer): string {
  return buf.toString("base64url");
}

/** The token's claims when its signature matches `secret` and it has not expired; otherwise null. */
export function verifyHs256(token: string, secret: string, nowSeconds: number = Math.floor(Date.now() / 1000)): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length !== 3 || !secret) return null;
  const [head, body, sig] = parts;
  try {
    const header: unknown = JSON.parse(Buffer.from(head, "base64url").toString("utf8"));
    if (typeof header !== "object" || header === null || (header as { alg?: unknown }).alg !== "HS256") return null;
    const expected = createHmac("sha256", secret).update(`${head}.${body}`).digest();
    const given = Buffer.from(sig, "base64url");
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
    const claims: unknown = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    if (typeof claims !== "object" || claims === null || Array.isArray(claims)) return null;
    const exp = (claims as { exp?: unknown }).exp;
    if (typeof exp === "number" && exp < nowSeconds) return null;
    return claims as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Sign claims the way Inkress does. Used by tests and the local webhook check. */
export function signHs256(claims: Record<string, unknown>, secret: string): string {
  const head = b64url(Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const body = b64url(Buffer.from(JSON.stringify(claims)));
  const sig = b64url(createHmac("sha256", secret).update(`${head}.${body}`).digest());
  return `${head}.${body}.${sig}`;
}
