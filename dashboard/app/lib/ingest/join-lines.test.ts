import { describe, expect, test } from "bun:test";
import { BUILT_IN_PATTERNS, compileFilter } from "~/lib/controls.server";
import { enforceStreams, type LokiStream } from "./enforce.server";
import { joinSplitEntries } from "./join-lines";

// The real Courier Portal block as an agent without the collector join sends it: one value per
// line, the header in the level=error stream and the rest in the level=info stream.
const BLOCK = [
  "[error] Uncaught in GET /help | GET /help | company 12 | user 34",
  "ReferenceError: /app/views/pages/help.ejs:1",
  " >> 1| <%- include(partialhead); %>",
  "    2| <script>",
  "",
  "partialhead is not defined",
  "    at eval (/app/views/pages/help.ejs:10:25)",
  "    at help (/app/node_modules/ejs/lib/ejs.js:691:17) trace_id=e2b146c09e2c8027f37cb280ed949389",
];
const T0 = 1794955682986000000n;
const labels = (level: string): Record<string, string> => ({ service: "prod-courier-portal-client", source: "prod-courier-portal-client", host: "dserve", level, kind: "log" });
const env = (message: string): string => JSON.stringify({ message, display: message, service: "prod-courier-portal-client", level: "x", kind: "log" });

function split(lines: readonly string[], start = T0): LokiStream[] {
  const err: unknown[][] = [];
  const info: unknown[][] = [];
  lines.forEach((l, i) => (i === 0 ? err : info).push([String(start + BigInt(i) * 8000n), env(l)]));
  return [{ stream: labels("error"), values: err }, { stream: labels("info"), values: info }];
}

const messages = (streams: readonly LokiStream[]): string[] =>
  streams.flatMap((s) => s.values.map((v) => (JSON.parse(String(v[1])) as { message: string }).message));

describe("joinSplitEntries (BAC-94)", () => {
  test("a split Courier Portal block becomes one error entry; display follows message", () => {
    const out = joinSplitEntries(split(BLOCK));
    expect(messages(out)).toEqual([BLOCK.join("\n")]);
    const v = JSON.parse(String(out[0].values[0][1])) as { display: string };
    expect(v.display).toBe(BLOCK.join("\n"));
  });
  test("ordinary info lines around it stay separate, and a far-off line is not joined", () => {
    const lines = [...BLOCK, "    at later (/x.js:1:1)"];
    const streams = split(lines);
    // the last frame arrives 3 s later: not part of the block
    streams[1].values[streams[1].values.length - 1][0] = String(T0 + 3_000_000_000n);
    streams[1].values.push([String(T0 + 100n), env("Successfully uploaded object: a.jpeg")]);
    const got = messages(joinSplitEntries(streams));
    expect(got).toContain("Successfully uploaded object: a.jpeg");
    expect(got).toContain("    at later (/x.js:1:1)");
    expect(got.filter((m) => m.startsWith("[error]"))).toHaveLength(1);
  });
  test("only an error-level line opens a block: info lines followed by frames are left alone", () => {
    const streams: LokiStream[] = [{ stream: labels("info"), values: [[String(T0), env("V5 Package [")], [String(T0 + 1n), env("  { a: 1 }")]] }];
    expect(messages(joinSplitEntries(streams))).toEqual(["V5 Package [", "  { a: 1 }"]);
  });
  test("a Name: line joins only right after the header; other services' lines never join", () => {
    const streams = split(["[error] GET /login | GET /login", "TypeError: x", "    at /a.js:1:2"]);
    streams.push({ stream: { ...labels("info"), service: "other", source: "other" }, values: [[String(T0 + 1n), env("    at other (/o.js:1:1)")]] });
    const got = messages(joinSplitEntries(streams));
    expect(got).toContain("[error] GET /login | GET /login\nTypeError: x\n    at /a.js:1:2");
    expect(got).toContain("    at other (/o.js:1:1)");
  });
  test("an already joined push is returned unchanged", () => {
    const streams: LokiStream[] = [{ stream: labels("error"), values: [[String(T0), env(BLOCK.join("\n"))]] }];
    expect(joinSplitEntries(streams)).toEqual(streams);
  });
  test("end to end with enforce: one error event with type, message, stack and the trace id", () => {
    const r = enforceStreams(joinSplitEntries(split(BLOCK)), { projectId: null, rows: [], filter: compileFilter(BUILT_IN_PATTERNS), deriveErrors: true });
    expect(r.errors).toHaveLength(1);
    const e = r.errors[0];
    expect(e.type).toBe("ReferenceError");
    expect(e.errorMessage).toBe("partialhead is not defined");
    expect(e.stack).toContain("at eval (/app/views/pages/help.ejs:10:25)");
    expect(e.traceId).toBe("e2b146c09e2c8027f37cb280ed949389");
    expect(r.kept).toBe(1);
  });
  test("a header followed by an entry the collector already joined from the Name: line is joined", () => {
    const streams: LokiStream[] = [
      { stream: labels("error"), values: [[String(T0), env("[error] GET /login | GET /login")]] },
      { stream: labels("info"), values: [[String(T0 + 900_000_000n), env("ApiError: GET /a failed: ECONNREFUSED\n    at /a.js:1:2")]] },
    ];
    expect(messages(joinSplitEntries(streams))).toEqual(["[error] GET /login | GET /login\nApiError: GET /a failed: ECONNREFUSED\n    at /a.js:1:2"]);
  });
});
