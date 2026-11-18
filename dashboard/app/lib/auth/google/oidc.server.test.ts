import { beforeEach, describe, expect, test } from "bun:test";
import { buildAuthorizationUrl, clearKeyCache, completeAuthorization, newAuthRequestSecrets, pkceChallenge, type FetchLike, type GoogleOidcSettings } from "./oidc.server";
import { GoogleAuthError, GoogleErrorCode } from "./types";
import { CLIENT_ID, goodClaims, makeSigner } from "./test-helpers";

const SETTINGS: GoogleOidcSettings = {
  clientId: CLIENT_ID,
  clientSecret: "secret",
  redirectUri: "https://backwork.dev/auth/google/callback",
  authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
  tokenUrl: "https://oauth2.googleapis.com/token",
  jwksUrl: "https://www.googleapis.com/oauth2/v3/certs",
};

describe("authorization url", () => {
  test("asks for openid email profile with state, nonce, S256 PKCE and an account chooser", () => {
    const secrets = newAuthRequestSecrets();
    const u = new URL(buildAuthorizationUrl(SETTINGS, secrets));
    expect(u.origin + u.pathname).toBe(SETTINGS.authUrl);
    expect(u.searchParams.get("response_type")).toBe("code");
    expect(u.searchParams.get("scope")).toBe("openid email profile");
    expect(u.searchParams.get("prompt")).toBe("select_account");
    expect(u.searchParams.get("state")).toBe(secrets.state);
    expect(u.searchParams.get("nonce")).toBe(secrets.nonce);
    expect(u.searchParams.get("code_challenge_method")).toBe("S256");
    expect(u.searchParams.get("code_challenge")).toBe(pkceChallenge(secrets.verifier));
    expect(u.searchParams.get("redirect_uri")).toBe(SETTINGS.redirectUri);
  });

  test("secrets are unique and long enough", () => {
    const a = newAuthRequestSecrets();
    const b = newAuthRequestSecrets();
    expect(a.state).not.toBe(b.state);
    expect(a.verifier.length).toBeGreaterThanOrEqual(43);
  });

  test("PKCE challenge matches the RFC 7636 example", () => {
    expect(pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });
});

describe("completeAuthorization", () => {
  const now = new Date("2026-11-18T10:00:00Z");
  const { jwk, sign } = makeSigner();
  beforeEach(() => clearKeyCache());

  function fakeGoogle(opts: { idToken?: string; tokenStatus?: number; keys?: unknown[] } = {}) {
    const calls: Array<{ url: string; body: string }> = [];
    const fetcher: FetchLike = async (url, init) => {
      calls.push({ url, body: String(init?.body ?? "") });
      if (url === SETTINGS.tokenUrl) {
        if (opts.tokenStatus && opts.tokenStatus !== 200) return new Response("nope", { status: opts.tokenStatus });
        return Response.json({ id_token: opts.idToken ?? "", access_token: "x" });
      }
      if (url === SETTINGS.jwksUrl) return Response.json({ keys: opts.keys ?? [jwk] });
      return new Response("?", { status: 404 });
    };
    return { fetcher, calls };
  }

  test("exchanges the code with the PKCE verifier and returns the verified identity", async () => {
    const { fetcher, calls } = fakeGoogle({ idToken: sign(goodClaims("n1", now)) });
    const id = await completeAuthorization(SETTINGS, { code: "the-code", verifier: "the-verifier", nonce: "n1" }, fetcher, now);
    expect(id.email).toBe("ada.lovelace@example.com");
    const form = new URLSearchParams(calls[0].body);
    expect(form.get("grant_type")).toBe("authorization_code");
    expect(form.get("code")).toBe("the-code");
    expect(form.get("code_verifier")).toBe("the-verifier");
    expect(form.get("client_secret")).toBe("secret");
    expect(form.get("redirect_uri")).toBe(SETTINGS.redirectUri);
  });

  test("a failing token endpoint is an exchange failure, not a crash", async () => {
    const { fetcher } = fakeGoogle({ tokenStatus: 400 });
    const err = await completeAuthorization(SETTINGS, { code: "c", verifier: "v", nonce: "n1" }, fetcher, now).catch((e) => e);
    expect(err).toBeInstanceOf(GoogleAuthError);
    expect((err as GoogleAuthError).code).toBe(GoogleErrorCode.ExchangeFailed);
  });

  test("an unreachable token endpoint is an exchange failure", async () => {
    const fetcher: FetchLike = async () => {
      throw new Error("ECONNREFUSED");
    };
    const err = await completeAuthorization(SETTINGS, { code: "c", verifier: "v", nonce: "n1" }, fetcher, now).catch((e) => e);
    expect((err as GoogleAuthError).code).toBe(GoogleErrorCode.ExchangeFailed);
  });

  test("a token for the wrong nonce or an unverified email is refused", async () => {
    const wrongNonce = fakeGoogle({ idToken: sign(goodClaims("other", now)) });
    expect(((await completeAuthorization(SETTINGS, { code: "c", verifier: "v", nonce: "n1" }, wrongNonce.fetcher, now).catch((e) => e)) as GoogleAuthError).code).toBe(GoogleErrorCode.TokenInvalid);
    clearKeyCache();
    const unverified = fakeGoogle({ idToken: sign(goodClaims("n1", now, { email_verified: false })) });
    expect(((await completeAuthorization(SETTINGS, { code: "c", verifier: "v", nonce: "n1" }, unverified.fetcher, now).catch((e) => e)) as GoogleAuthError).code).toBe(GoogleErrorCode.EmailUnverified);
  });

  test("keys are cached between sign-ins and refetched once for an unknown key id", async () => {
    const first = fakeGoogle({ idToken: sign(goodClaims("n1", now)) });
    await completeAuthorization(SETTINGS, { code: "c", verifier: "v", nonce: "n1" }, first.fetcher, now);
    const second = fakeGoogle({ idToken: sign(goodClaims("n2", now)) });
    await completeAuthorization(SETTINGS, { code: "c", verifier: "v", nonce: "n2" }, second.fetcher, now);
    expect(second.calls.filter((c) => c.url === SETTINGS.jwksUrl).length).toBe(0);

    const rotated = makeSigner("rotated");
    const third = fakeGoogle({ idToken: rotated.sign(goodClaims("n3", now)), keys: [jwk, rotated.jwk] });
    const id = await completeAuthorization(SETTINGS, { code: "c", verifier: "v", nonce: "n3" }, third.fetcher, now);
    expect(id.sub).toBe("1100223344");
    expect(third.calls.filter((c) => c.url === SETTINGS.jwksUrl).length).toBe(1);
  });
});
