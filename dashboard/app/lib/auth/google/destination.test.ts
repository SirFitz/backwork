import { describe, expect, test } from "bun:test";
import { googleDestination, inviteTokenFromPath } from "./destination";
import { GOOGLE_ERROR_COPY, GoogleErrorCode, GoogleIntent, googleErrorMessage, googleStartHref, isGoogleManagedEmail } from "./types";

describe("googleDestination", () => {
  test("people with an organisation go to next, people without go to onboarding", () => {
    expect(googleDestination({ hasMembership: true, next: "/requests", plan: null })).toBe("/requests");
    expect(googleDestination({ hasMembership: false, next: "/requests", plan: null })).toBe("/onboarding");
  });
  test("the plan survives into onboarding", () => {
    expect(googleDestination({ hasMembership: false, next: "/", plan: "team" })).toBe("/onboarding?plan=team");
  });
  test("an invite link wins even for a brand new user", () => {
    expect(googleDestination({ hasMembership: false, next: "/invite/abc123", plan: null })).toBe("/invite/abc123");
  });
});

describe("inviteTokenFromPath", () => {
  test("reads the token of an invite path only", () => {
    expect(inviteTokenFromPath("/invite/abc123")).toBe("abc123");
    expect(inviteTokenFromPath("/invite/abc123?x=1")).toBe("abc123");
    expect(inviteTokenFromPath("/invitex/abc")).toBeNull();
    expect(inviteTokenFromPath("/requests")).toBeNull();
  });
});

describe("google vocabulary", () => {
  test("start link carries intent, next and plan only when they matter", () => {
    expect(googleStartHref({ intent: GoogleIntent.SignIn })).toBe("/auth/google/start?intent=signin");
    expect(googleStartHref({ intent: GoogleIntent.SignIn, next: "/" })).toBe("/auth/google/start?intent=signin");
    expect(googleStartHref({ intent: GoogleIntent.SignUp, next: "/invite/a b", plan: "team" })).toBe("/auth/google/start?intent=signup&next=%2Finvite%2Fa+b&plan=team");
    expect(googleStartHref({ intent: GoogleIntent.SignUp, hint: "j@acme.com" })).toBe("/auth/google/start?intent=signup&hint=j%40acme.com");
  });
  test("every error code has one plain sentence, in British English with no dashes", () => {
    for (const code of Object.values(GoogleErrorCode)) {
      const copy = GOOGLE_ERROR_COPY[code];
      expect(copy.length).toBeGreaterThan(10);
      expect(copy).not.toMatch(/[–—]/);
    }
    expect(googleErrorMessage("cancelled")).toBe(GOOGLE_ERROR_COPY.cancelled);
    expect(googleErrorMessage("<script>")).toBeNull();
    expect(googleErrorMessage(null)).toBeNull();
  });
});

describe("isGoogleManagedEmail", () => {
  test("Gmail and Workspace accounts count, other addresses do not", () => {
    expect(isGoogleManagedEmail("a@gmail.com", null)).toBe(true);
    expect(isGoogleManagedEmail("a@GoogleMail.com", null)).toBe(true);
    expect(isGoogleManagedEmail("a@acme.com", "acme.com")).toBe(true);
    expect(isGoogleManagedEmail("a@acme.com", null)).toBe(false);
    expect(isGoogleManagedEmail("a@notgmail.com", null)).toBe(false);
    expect(isGoogleManagedEmail("a@gmail.com.evil.io", null)).toBe(false);
  });
});
