import { describe, expect, test } from "bun:test";
import { ErrorKind, describeError, describePanelError } from "./error-copy";

describe("describeError", () => {
  test("a browser fetch failure is unreachable, recovers by itself, and never shows the raw words in copy", () => {
    const c = describeError({ message: "Failed to fetch", online: true });
    expect(c.kind).toBe(ErrorKind.Unreachable);
    expect(c.autoRecover).toBe(true);
    expect(c.canRetry).toBe(true);
    expect(`${c.title} ${c.body}`).not.toMatch(/failed to fetch/i);
    expect(c.detail).toBe("Failed to fetch");
  });

  test("Safari and Firefox spellings are network failures too", () => {
    expect(describeError({ message: "Load failed" }).kind).toBe(ErrorKind.Unreachable);
    expect(describeError({ message: "NetworkError when attempting to fetch resource." }).kind).toBe(ErrorKind.Unreachable);
  });

  test("no connection reads as offline", () => {
    const c = describeError({ message: "Failed to fetch", online: false });
    expect(c.kind).toBe(ErrorKind.Offline);
    expect(c.autoRecover).toBe(true);
  });

  test("status codes map to a plain heading", () => {
    expect(describeError({ status: 404 }).kind).toBe(ErrorKind.NotFound);
    expect(describeError({ status: 403 }).kind).toBe(ErrorKind.Forbidden);
    expect(describeError({ status: 401 }).kind).toBe(ErrorKind.SignedOut);
    expect(describeError({ status: 500 }).kind).toBe(ErrorKind.Server);
    expect(describeError({ status: 503 }).kind).toBe(ErrorKind.Unreachable);
  });

  test("an unknown error keeps its message out of the copy and trims the detail", () => {
    const c = describeError({ message: "TypeError: Cannot read properties of undefined (reading 'x')\n    at foo (bundle.js:1:1)" + "x".repeat(400) });
    expect(c.kind).toBe(ErrorKind.Unknown);
    expect(c.body).not.toContain("Cannot read");
    expect(c.detail.length).toBeLessThanOrEqual(160);
    expect(c.detail).not.toContain("\n");
  });

  test("copy has no em dashes", () => {
    for (const input of [{ status: 404 }, { status: 500 }, { message: "Failed to fetch" }, { message: "x" }, { online: false }]) {
      const c = describeError(input);
      expect(`${c.title}${c.body}`).not.toContain("—");
    }
  });
});

describe("describePanelError", () => {
  test("never echoes the raw failure", () => {
    const line = describePanelError("connect ECONNREFUSED 10.0.1.7:5432");
    expect(line).not.toContain("10.0.1.7");
    expect(line).toMatch(/reload/i);
    expect(describePanelError("relation \"x\" does not exist")).not.toContain("relation");
    expect(describePanelError(null)).toMatch(/reload/i);
  });
});
