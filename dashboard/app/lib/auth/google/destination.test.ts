import { describe, expect, test } from "bun:test";
import { googleDestination } from "./destination";
import { GOOGLE_ERROR_COPY, GoogleErrorCode, GoogleIntent, googleErrorMessage, googleStartHref } from "./types";

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

describe("google vocabulary", () => {
  test("start link carries intent, next and plan only when they matter", () => {
    expect(googleStartHref({ intent: GoogleIntent.SignIn })).toBe("/auth/google/start?intent=signin");
    expect(googleStartHref({ intent: GoogleIntent.SignIn, next: "/" })).toBe("/auth/google/start?intent=signin");
    expect(googleStartHref({ intent: GoogleIntent.SignUp, next: "/invite/a b", plan: "team" })).toBe("/auth/google/start?intent=signup&next=%2Finvite%2Fa+b&plan=team");
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
