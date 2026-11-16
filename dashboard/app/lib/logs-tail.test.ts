import { describe, expect, test } from "bun:test";
import { lineKey, mergeNewLines, msToNs, newestNs, parseSince, type LogLine } from "./logs-tail";

function line(tsNs: string, message = `m${tsNs}`, service = "api"): LogLine {
  return { ts: Number(BigInt(tsNs) / 1_000_000n), tsNs, level: "info", service, message, traceId: null };
}

describe("parseSince", () => {
  test("takes a nanosecond timestamp", () => {
    expect(parseSince("1763200000123456789")).toBe("1763200000123456789");
    expect(parseSince(" 1763200000123456789 ")).toBe("1763200000123456789");
  });
  test("ignores missing, empty and non-numeric values", () => {
    expect(parseSince(null)).toBeNull();
    expect(parseSince("")).toBeNull();
    expect(parseSince("abc")).toBeNull();
    expect(parseSince("-5")).toBeNull();
    expect(parseSince("1.5e18")).toBeNull();
    expect(parseSince("1".repeat(23))).toBeNull();
    expect(parseSince('1"} |= "x')).toBeNull();
  });
});

describe("msToNs", () => {
  test("multiplies exactly, beyond float precision", () => {
    expect(msToNs(1763200000123)).toBe("1763200000123000000");
  });
});

describe("newestNs", () => {
  test("the largest timestamp, compared exactly", () => {
    expect(newestNs([line("1763200000000000002"), line("1763200000000000009"), line("1763200000000000001")], "0")).toBe("1763200000000000009");
  });
  test("the fallback when nothing is shown", () => {
    expect(newestNs([], "1763200000000000000")).toBe("1763200000000000000");
  });
});

describe("mergeNewLines", () => {
  const shown = [line("300"), line("200"), line("100")];

  test("new lines go on top, newest first", () => {
    const r = mergeNewLines(shown, [line("400"), line("500")]);
    expect(r.added).toBe(2);
    expect(r.lines.map((l) => l.tsNs)).toEqual(["500", "400", "300", "200", "100"]);
  });

  test("the inclusive repeat of the newest shown line is dropped", () => {
    const r = mergeNewLines(shown, [line("400"), line("300")]);
    expect(r.added).toBe(1);
    expect(r.lines.map((l) => l.tsNs)).toEqual(["400", "300", "200", "100"]);
  });

  test("a different line at the same nanosecond is kept", () => {
    const r = mergeNewLines(shown, [line("300", "other")]);
    expect(r.added).toBe(1);
    expect(r.lines.length).toBe(4);
  });

  test("nothing new keeps the same lines and counts zero", () => {
    const r = mergeNewLines(shown, [line("300")]);
    expect(r.added).toBe(0);
    expect(r.lines).toEqual(shown);
  });

  test("the oldest lines past the cap are dropped", () => {
    const r = mergeNewLines(shown, [line("400"), line("500")], 4);
    expect(r.lines.map((l) => l.tsNs)).toEqual(["500", "400", "300", "200"]);
  });

  test("shown lines keep their identity, so React keeps their DOM nodes", () => {
    const r = mergeNewLines(shown, [line("400")]);
    expect(r.lines[1]).toBe(shown[0]);
    expect(lineKey(r.lines[1])).toBe(lineKey(shown[0]));
  });
});
