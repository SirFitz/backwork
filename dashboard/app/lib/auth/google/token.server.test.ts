import { describe, expect, test } from "bun:test";
import { GoogleAuthError, GoogleErrorCode } from "./types";
import { safeEqual, verifyIdToken } from "./token.server";
import { CLIENT_ID, goodClaims, makeSigner } from "./test-helpers";

const NOW = new Date("2026-11-18T10:00:00Z");
const NONCE = "nonce-abc";

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    if (e instanceof GoogleAuthError) return e.code;
    throw e;
  }
  return "none";
}

describe("verifyIdToken", () => {
  const { jwk, sign } = makeSigner();
  const opts = { clientId: CLIENT_ID, nonce: NONCE, keys: [jwk], now: NOW };

  test("accepts a good token and lowercases the email", () => {
    const id = verifyIdToken(sign(goodClaims(NONCE, NOW)), opts);
    expect(id).toEqual({ sub: "1100223344", email: "ada.lovelace@example.com", name: "Ada Lovelace", hostedDomain: null });
  });

  test("accepts the bare accounts.google.com issuer and an audience list", () => {
    expect(verifyIdToken(sign(goodClaims(NONCE, NOW, { iss: "accounts.google.com", aud: ["other", CLIENT_ID] })), opts).sub).toBe("1100223344");
  });

  test("carries the Workspace domain (hd) when present", () => {
    expect(verifyIdToken(sign(goodClaims(NONCE, NOW, { hd: "example.com" })), opts).hostedDomain).toBe("example.com");
  });

  test("refuses a wrong issuer", () => {
    expect(codeOf(() => verifyIdToken(sign(goodClaims(NONCE, NOW, { iss: "https://evil.example" })), opts))).toBe(GoogleErrorCode.TokenInvalid);
  });

  test("refuses another client's audience", () => {
    expect(codeOf(() => verifyIdToken(sign(goodClaims(NONCE, NOW, { aud: "someone-else" })), opts))).toBe(GoogleErrorCode.TokenInvalid);
  });

  test("refuses an expired token but allows a little clock skew", () => {
    const t = Math.floor(NOW.getTime() / 1000);
    expect(codeOf(() => verifyIdToken(sign(goodClaims(NONCE, NOW, { exp: t - 120 })), opts))).toBe(GoogleErrorCode.TokenInvalid);
    expect(codeOf(() => verifyIdToken(sign(goodClaims(NONCE, NOW, { exp: t - 30 })), opts))).toBe("none");
  });

  test("refuses a wrong nonce", () => {
    expect(codeOf(() => verifyIdToken(sign(goodClaims("other-nonce", NOW)), opts))).toBe(GoogleErrorCode.TokenInvalid);
  });

  test("refuses an unverified email, and a string 'true'", () => {
    expect(codeOf(() => verifyIdToken(sign(goodClaims(NONCE, NOW, { email_verified: false })), opts))).toBe(GoogleErrorCode.EmailUnverified);
    expect(codeOf(() => verifyIdToken(sign(goodClaims(NONCE, NOW, { email_verified: "true" })), opts))).toBe(GoogleErrorCode.EmailUnverified);
    const { email_verified: _drop, ...noFlag } = goodClaims(NONCE, NOW);
    expect(codeOf(() => verifyIdToken(sign(noFlag), opts))).toBe(GoogleErrorCode.EmailUnverified);
  });

  test("refuses a token signed by another key", () => {
    const other = makeSigner();
    expect(codeOf(() => verifyIdToken(other.sign(goodClaims(NONCE, NOW)), opts))).toBe(GoogleErrorCode.TokenInvalid);
  });

  test("refuses an edited payload and a non-RS256 algorithm", () => {
    const [h, , s] = sign(goodClaims(NONCE, NOW)).split(".");
    const forged = Buffer.from(JSON.stringify(goodClaims(NONCE, NOW, { email: "victim@example.com" }))).toString("base64url");
    expect(codeOf(() => verifyIdToken(`${h}.${forged}.${s}`, opts))).toBe(GoogleErrorCode.TokenInvalid);
    expect(codeOf(() => verifyIdToken(sign(goodClaims(NONCE, NOW), { alg: "none" }), opts))).toBe(GoogleErrorCode.TokenInvalid);
    expect(codeOf(() => verifyIdToken(sign(goodClaims(NONCE, NOW), { alg: "HS256" }), opts))).toBe(GoogleErrorCode.TokenInvalid);
  });

  test("refuses an unknown key id and garbage", () => {
    expect(codeOf(() => verifyIdToken(sign(goodClaims(NONCE, NOW), { kid: "nope" }), opts))).toBe(GoogleErrorCode.TokenInvalid);
    expect(codeOf(() => verifyIdToken("not.a.jwt", opts))).toBe(GoogleErrorCode.TokenInvalid);
    expect(codeOf(() => verifyIdToken("x", opts))).toBe(GoogleErrorCode.TokenInvalid);
  });
});

describe("safeEqual", () => {
  test("compares equal, different and different-length strings", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abd")).toBe(false);
    expect(safeEqual("abc", "abcd")).toBe(false);
    expect(safeEqual("", "")).toBe(true);
  });
});
