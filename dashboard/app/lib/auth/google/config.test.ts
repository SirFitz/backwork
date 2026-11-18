import { afterEach, describe, expect, test } from "bun:test";
import { googleAuthConfigured, googleAuthSettings, isLocalTestHost, resetGoogleWarningsForTest } from "~/lib/config.server";

const KEYS = ["GOOGLE_SIGNIN_CLIENT_ID", "GOOGLE_SIGNIN_CLIENT_SECRET", "GOOGLE_SIGNIN_REDIRECT_URI", "GOOGLE_SIGNIN_AUTH_URL", "GOOGLE_SIGNIN_TOKEN_URL", "GOOGLE_SIGNIN_JWKS_URL", "GOOGLE_SIGNIN_TEST_ENDPOINTS", "NODE_ENV", "PUBLIC_URL"];
const saved = new Map(KEYS.map((k) => [k, process.env[k]]));
afterEach(() => {
  resetGoogleWarningsForTest();
  for (const [k, v] of saved) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("googleAuthConfigured", () => {
  test("off until both the client id and secret are set", () => {
    delete process.env.GOOGLE_SIGNIN_CLIENT_ID;
    delete process.env.GOOGLE_SIGNIN_CLIENT_SECRET;
    expect(googleAuthConfigured()).toBe(false);
    process.env.GOOGLE_SIGNIN_CLIENT_ID = "id";
    expect(googleAuthConfigured()).toBe(false);
    process.env.GOOGLE_SIGNIN_CLIENT_SECRET = "secret";
    process.env.PUBLIC_URL = "https://staging.backwork.dev";
    expect(googleAuthConfigured()).toBe(true);
  });

  test("stays off when neither a redirect URI nor an explicit PUBLIC_URL is set", () => {
    process.env.GOOGLE_SIGNIN_CLIENT_ID = "id";
    process.env.GOOGLE_SIGNIN_CLIENT_SECRET = "secret";
    delete process.env.PUBLIC_URL;
    delete process.env.GOOGLE_SIGNIN_REDIRECT_URI;
    expect(googleAuthConfigured()).toBe(false);
    process.env.PUBLIC_URL = "";
    expect(googleAuthConfigured()).toBe(false);
    process.env.GOOGLE_SIGNIN_REDIRECT_URI = "https://backwork.dev/auth/google/callback";
    expect(googleAuthConfigured()).toBe(true);
  });
});

describe("googleAuthSettings", () => {
  test("defaults to Google's endpoints and the public URL callback", () => {
    process.env.PUBLIC_URL = "https://backwork.dev/";
    delete process.env.GOOGLE_SIGNIN_REDIRECT_URI;
    const s = googleAuthSettings();
    expect(s.redirectUri).toBe("https://backwork.dev/auth/google/callback");
    expect(s.authUrl).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(s.tokenUrl).toBe("https://oauth2.googleapis.com/token");
    expect(s.jwksUrl).toBe("https://www.googleapis.com/oauth2/v3/certs");
  });

  test("endpoint overrides are honoured outside production", () => {
    process.env.NODE_ENV = "development";
    process.env.GOOGLE_SIGNIN_TOKEN_URL = "http://localhost:4010/token";
    expect(googleAuthSettings().tokenUrl).toBe("http://localhost:4010/token");
  });

  test("endpoint overrides are ignored in production unless the test flag is set", () => {
    process.env.NODE_ENV = "production";
    delete process.env.GOOGLE_SIGNIN_TEST_ENDPOINTS;
    process.env.GOOGLE_SIGNIN_TOKEN_URL = "http://evil.example/token";
    process.env.GOOGLE_SIGNIN_AUTH_URL = "http://evil.example/auth";
    process.env.GOOGLE_SIGNIN_JWKS_URL = "http://evil.example/certs";
    const s = googleAuthSettings();
    expect(s.tokenUrl).toBe("https://oauth2.googleapis.com/token");
    expect(s.authUrl).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(s.jwksUrl).toBe("https://www.googleapis.com/oauth2/v3/certs");
    process.env.GOOGLE_SIGNIN_TEST_ENDPOINTS = "1";
    expect(googleAuthSettings().tokenUrl).toBe("https://oauth2.googleapis.com/token"); // flag set but host not local
    process.env.GOOGLE_SIGNIN_TOKEN_URL = "http://host.docker.internal:4010/token";
    process.env.GOOGLE_SIGNIN_AUTH_URL = "http://localhost:4010/authorize";
    process.env.GOOGLE_SIGNIN_JWKS_URL = "http://host.docker.internal:4010/certs";
    expect(googleAuthSettings().tokenUrl).toBe("http://host.docker.internal:4010/token");
  });

  test("an explicit redirect URI wins over the public URL", () => {
    process.env.GOOGLE_SIGNIN_REDIRECT_URI = "https://other.example/cb";
    expect(googleAuthSettings().redirectUri).toBe("https://other.example/cb");
  });

  test("overrides pointing at a non-local host are all discarded, even outside production", () => {
    process.env.NODE_ENV = "development";
    process.env.GOOGLE_SIGNIN_TOKEN_URL = "http://localhost:4010/token";
    process.env.GOOGLE_SIGNIN_JWKS_URL = "https://evil.example/certs";
    const s = googleAuthSettings();
    expect(s.tokenUrl).toBe("https://oauth2.googleapis.com/token");
    expect(s.jwksUrl).toBe("https://www.googleapis.com/oauth2/v3/certs");
  });
});

describe("isLocalTestHost", () => {
  test("loopback, Docker host alias and bare service names only", () => {
    for (const h of ["localhost", "127.0.0.1", "[::1]", "host.docker.internal", "fake-oidc"]) expect(isLocalTestHost(h)).toBe(true);
    for (const h of ["", "evil.example", "accounts.google.com", "10.0.0.5", "localhost.evil.com"]) expect(isLocalTestHost(h)).toBe(false);
  });
});
