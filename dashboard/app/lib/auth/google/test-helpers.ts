import { generateKeyPairSync, createSign } from "node:crypto";
import type { Jwk } from "./token.server";

/** Test-only: an RSA key pair standing in for Google's signing key, and a way to mint ID tokens with it. */
export function makeSigner(kid = "test-key") {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk: Jwk = { ...(publicKey.export({ format: "jwk" }) as Jwk), kid, alg: "RS256", use: "sig" };
  const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
  function sign(claims: Record<string, unknown>, header: Record<string, unknown> = {}): string {
    const h = b64({ alg: "RS256", kid, typ: "JWT", ...header });
    const p = b64(claims);
    const sig = createSign("RSA-SHA256").update(`${h}.${p}`).sign(privateKey).toString("base64url");
    return `${h}.${p}.${sig}`;
  }
  return { jwk, sign };
}

export const CLIENT_ID = "client-123.apps.googleusercontent.com";

export function goodClaims(nonce: string, now: Date, over: Record<string, unknown> = {}): Record<string, unknown> {
  const t = Math.floor(now.getTime() / 1000);
  return {
    iss: "https://accounts.google.com",
    aud: CLIENT_ID,
    sub: "1100223344",
    email: "Ada.Lovelace@Example.com",
    email_verified: true,
    name: "Ada Lovelace",
    nonce,
    iat: t,
    exp: t + 3600,
    ...over,
  };
}
