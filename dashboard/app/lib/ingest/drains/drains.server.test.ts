import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { join } from "node:path";
import { BUILT_IN_PATTERNS, compileFilter } from "~/lib/controls.server";
import { LineKind, classifyLine, enforceStreams, type EnforceContext } from "~/lib/ingest/enforce.server";
import { Level, TIME_WINDOW_NS, linesToStreams, lineOf, rfc3339Ns, stampedLine, timeWithin } from "~/lib/ingest/records.server";
import { parseCloudflare } from "./cloudflare.server";
import { anyTimeNs, entriesToLines, entryLine, jsonObjects, levelWord, unpacked, type DrainEntry, type DrainParse } from "./entry.server";
import { parseFly } from "./fly.server";
import { herokuEntry, octetFrames, parseHeroku } from "./heroku.server";
import { DRAIN_PARSERS, emptyAnswer, fallbackService } from "./index.server";
import { DRAIN_PLATFORMS, DrainPlatform, TOKEN_PLACEHOLDER, drainGuides, drainPath, drainPlatformOf } from "./platforms";
import { parseVercel } from "./vercel.server";

const fixture = (name: string): Buffer => readFileSync(join(import.meta.dir, "fixtures", name));
const H = new Headers();
const entriesOf = (r: DrainParse): DrainEntry[] => {
  if (!r.ok) throw new Error(r.reason);
  return r.entries;
};
const NO_ORIGIN = { service: null, host: null };
const parsedLine = (line: string): Record<string, unknown> => JSON.parse(line) as Record<string, unknown>;

describe("drain platforms", () => {
  test("one parser per platform, unknown platforms refused", () => {
    expect(Object.keys(DRAIN_PARSERS).sort()).toEqual([...DRAIN_PLATFORMS].sort());
    expect(drainPlatformOf("vercel")).toBe(DrainPlatform.Vercel);
    expect(drainPlatformOf("render")).toBeNull();
    expect(drainPlatformOf(undefined)).toBeNull();
    expect(drainPath(DrainPlatform.Fly)).toBe("/ingest/drains/fly");
    expect(fallbackService(DrainPlatform.Heroku)).toBe("heroku");
    expect(emptyAnswer(DrainPlatform.Heroku)).toBe(true);
    expect(emptyAnswer(DrainPlatform.Vercel)).toBe(false);
  });

  test("setup steps carry the drain URL and token, never a query-string token except Cloudflare's header_ parameter", () => {
    const guides = drainGuides("https://backwork.dev/", "tok123");
    expect(guides.map((g) => g.platform)).toEqual([...DRAIN_PLATFORMS]);
    const copies = (p: DrainPlatform): string => guides.find((g) => g.platform === p)!.steps.map((s) => s.copy ?? "").join("\n");
    expect(copies(DrainPlatform.Vercel)).toContain("https://backwork.dev/ingest/drains/vercel");
    expect(copies(DrainPlatform.Vercel)).toContain("Authorization: Bearer tok123");
    expect(copies(DrainPlatform.Heroku)).toContain('"https://bw:tok123@backwork.dev/ingest/drains/heroku?service=my-api"');
    expect(copies(DrainPlatform.Fly)).toContain("HTTP_URL=https://backwork.dev/ingest/drains/fly HTTP_TOKEN=tok123");
    expect(copies(DrainPlatform.Cloudflare)).toContain("https://backwork.dev/ingest/drains/cloudflare?header_Authorization=Bearer%20tok123");
    expect(drainGuides("http://localhost:3000")[1].steps[0].copy).toContain(`http://bw:${TOKEN_PLACEHOLDER}@localhost:3000/`);
  });
});

describe("drain entries", () => {
  test("level words", () => {
    expect(levelWord("warning")).toBe(Level.Warn);
    expect(levelWord("ERROR")).toBe(Level.Error);
    expect(levelWord("log")).toBe(Level.Info);
    expect(levelWord("critical")).toBe(Level.Fatal);
    expect(levelWord("whatever")).toBeNull();
    expect(levelWord(null)).toBeNull();
  });

  test("timestamps in any unit", () => {
    const ns = 1_794_940_803_100_000_000n;
    expect(anyTimeNs(1794940803)).toBe(1_794_940_803_000_000_000n);
    expect(anyTimeNs(1794940803100)).toBe(ns);
    expect(anyTimeNs("1794940803100000000")).toBe(ns);
    expect(anyTimeNs("1794940803100000")).toBe(ns);
    expect(anyTimeNs("2026-11-17T18:40:03.1Z")).toBe(rfc3339Ns("2026-11-17T18:40:03.1Z"));
    expect(anyTimeNs("nope")).toBeNull();
    expect(anyTimeNs(0)).toBeNull();
  });

  test("JSON array, single object or NDJSON", () => {
    expect(jsonObjects('[{"a":1},2,{"b":2}]')).toEqual([{ a: 1 }, { b: 2 }]);
    expect(jsonObjects('{"a":1}\nnot json\n{"b":2}\n')).toEqual([{ a: 1 }, { b: 2 }]);
    expect(jsonObjects("[broken")).toBeNull();
    expect(jsonObjects("  ")).toEqual([]);
  });

  test("gzip sniffed without a header, corrupt gzip refused", () => {
    expect(unpacked(gzipSync("hello")).toString()).toBe("hello");
    expect(unpacked(Buffer.from("plain"))?.toString()).toBe("plain");
    expect(unpacked(Buffer.from([0x1f, 0x8b, 1, 2, 3]))).toBeNull();
    expect(unpacked(gzipSync(Buffer.alloc(2000)), 1000)).toBeNull();
  });

  test("stored line: hop records and structured lines as written, platform level wrapped, else as is", () => {
    const hop = "trace_id=6503f5f183b828139d5b143365ad72fa hop=in hop_id=5d9e0b3347c1a2f8 parent_id=b7ad6b7169203331 service=x adapter=node-http via=http method=GET op=/";
    const base = { service: null, host: null, timeNs: null };
    expect(entryLine({ ...base, message: hop, level: Level.Info })).toBe(hop);
    expect(entryLine({ ...base, message: '{"level":"warn","msg":"m"}', level: Level.Info })).toBe('{"level":"warn","msg":"m"}');
    expect(entryLine({ ...base, message: "plain", level: null })).toBe("plain");
    expect(parsedLine(entryLine({ ...base, message: "boom", level: Level.Error, fields: { request_id: "r1" } }))).toEqual({ level: "error", msg: "boom", request_id: "r1" });
  });

  test("a service named on the request wins, else the platform's, else the fallback; blank lines skipped", () => {
    const e = (service: string | null): DrainEntry => ({ message: "m", level: null, service, host: "h", timeNs: 1n });
    expect(entriesToLines([e("app"), e(null), e("bad name")], NO_ORIGIN, "fly").map((l) => l.service)).toEqual(["app", "fly", "fly"]);
    expect(entriesToLines([e("app")], { service: "mine", host: "box" }, "fly")[0]).toMatchObject({ service: "mine", host: "box" });
    expect(entriesToLines([{ ...e("a"), message: "  " }], NO_ORIGIN, "x")).toEqual([]);
  });
});

describe("line times (records pipeline)", () => {
  const NOW = 1_794_940_800_000_000_000n; // 2026-11-17T18:40:00Z

  test("RFC 3339 with any fraction and offset, to nanoseconds", () => {
    expect(rfc3339Ns("2026-11-17T18:40:00Z")).toBe(NOW);
    expect(rfc3339Ns("2026-11-17T18:40:00.123456789Z")).toBe(NOW + 123_456_789n);
    expect(rfc3339Ns("2026-11-17T13:40:00.5-05:00")).toBe(NOW + 500_000_000n);
    expect(rfc3339Ns("2026-11-17 18:40:00+00:00")).toBe(NOW);
    expect(rfc3339Ns("2026-11-17T18:40:00")).toBeNull();
    expect(rfc3339Ns("yesterday")).toBeNull();
  });

  test("records lines: <RFC 3339 or epoch ns>\\t<line>, else as posted", () => {
    expect(stampedLine(`2026-11-17T18:40:00.25Z\thello`)).toEqual({ line: "hello", timeNs: NOW + 250_000_000n });
    expect(stampedLine(`${NOW}\ttrace_id=abc hop=in`)).toEqual({ line: "trace_id=abc hop=in", timeNs: NOW });
    expect(stampedLine("2026-11-17T18:40:00Z hello")).toEqual({ line: "2026-11-17T18:40:00Z hello", timeNs: null });
    expect(stampedLine("12345\tnot a time")).toEqual({ line: "12345\tnot a time", timeNs: null });
    expect(stampedLine("key\tvalue")).toEqual({ line: "key\tvalue", timeNs: null });
  });

  test("times outside the window fall back to the receive time", () => {
    expect(timeWithin(NOW - 1000n, NOW)).toBe(NOW - 1000n);
    expect(timeWithin(NOW - TIME_WINDOW_NS.past - 1n, NOW)).toBeNull();
    expect(timeWithin(NOW + TIME_WINDOW_NS.future + 1n, NOW)).toBeNull();
    const streams = linesToStreams(
      [
        { line: "ok", timeNs: NOW - 5_000_000_000n },
        { line: "future", timeNs: NOW + 3600n * 1_000_000_000n },
        { line: "ancient", timeNs: 1_000_000_000n },
      ],
      { service: "s", host: null },
      NOW,
    );
    expect(streams[0].values.map((v) => v[0])).toEqual([String(NOW - 5_000_000_000n), String(NOW + 1n), String(NOW + 2n)]);
  });
});

describe("Vercel", () => {
  test("doc JSON sample: service, host, level, time, request and trace IDs", () => {
    const [build, lambda] = entriesOf(parseVercel(fixture("vercel.json"), H));
    expect(build).toMatchObject({ message: "Build completed successfully", level: Level.Info, service: "my-app", host: "build", timeNs: 1_573_817_187_330_000_000n });
    expect(lambda).toMatchObject({ service: "gdufoJxB6b9b1fEqr1jUtFkyavUU", host: "sfo1", timeNs: 1_573_817_250_283_000_000n });
    expect(parsedLine(entryLine(lambda))).toMatchObject({ level: "info", msg: "API request processed", request_id: "643af4e3-975a-4cc7-9e7a-1eda11539d90", trace_id: "1b02cd14bb8642fd092bc23f54c7ffcd", status: 200, path: "/api/users?page=1" });
  });

  test("NDJSON: errors, a hop record kept as written, a request log without a message", () => {
    const [err, hop, stat] = entriesOf(parseVercel(fixture("vercel.ndjson"), H));
    expect(err.level).toBe(Level.Error);
    expect(classifyLine(entryLine(hop)).kind).toBe(LineKind.Hop);
    expect(stat).toMatchObject({ message: "GET my-app.vercel.app/missing.png 404 MISS", level: Level.Warn, host: "iad1" });
  });

  test("not JSON is a 400", () => {
    expect(parseVercel(Buffer.from("[nope"), H).ok).toBe(false);
  });
});

describe("Heroku", () => {
  test("octet counting on bytes, doc sample verbatim", () => {
    const frames = octetFrames(fixture("heroku.logplex"));
    expect(frames).toEqual([
      "<40>1 2012-11-30T06:45:29+00:00 host app web.3 - State changed from starting to up",
      "<40>1 2012-11-30T06:45:26+00:00 host app web.3 - Starting process with command `bundle exec rackup config.ru -p 24405`",
    ]);
    const [first] = entriesOf(parseHeroku(fixture("heroku.logplex"), H));
    expect(first).toMatchObject({ message: "State changed from starting to up", level: null, host: "web.3", timeNs: rfc3339Ns("2012-11-30T06:45:29+00:00") });
  });

  test("router and platform levels, multi-byte text, plain lines without framing", () => {
    const [h12, ok, r14, app] = entriesOf(parseHeroku(fixture("heroku-router.logplex"), H));
    expect(h12).toMatchObject({ level: Level.Error, host: "router" });
    expect(h12.timeNs).toBe(rfc3339Ns("2012-11-30T06:45:30.123456+00:00"));
    expect(ok.level).toBe(Level.Info);
    expect(r14).toMatchObject({ level: Level.Error, host: "web.1", message: "Error R14 (Memory quota exceeded)" });
    expect(app.message).toBe("order 7731 placed — total £12.50");
    expect(octetFrames(Buffer.from("<190>1 2012-11-30T06:45:29+00:00 host app web.1 - a\n<190>1 2012-11-30T06:45:29+00:00 host app web.1 - b\n"))).toHaveLength(2);
    expect(herokuEntry("not syslog")).toMatchObject({ message: "not syslog", level: null });
  });
});

describe("Fly.io log shipper", () => {
  test("service = app, host = machine, level, nanosecond time; app JSON kept; hop record kept", () => {
    const [get, err, slow, hop] = entriesOf(parseFly(fixture("fly.json"), H));
    expect(get).toMatchObject({ service: "shop-api", host: "148e272a0e7d89", level: Level.Info, timeNs: 1_794_940_801_123_456_789n });
    expect(parsedLine(entryLine(err))).toMatchObject({ level: "error", msg: "database connection refused", region: "iad" });
    expect(parsedLine(entryLine(slow))).toEqual({ level: "warn", msg: "slow query", ms: 812 });
    expect(classifyLine(entryLine(hop)).kind).toBe(LineKind.Hop);
    const nd = fixture("fly.json").toString().replace(/^\[|\]\s*$/g, "").replace(/},\n/g, "}\n");
    expect(entriesOf(parseFly(Buffer.from(nd), H))).toHaveLength(4);
  });
});

describe("Cloudflare Logpush", () => {
  test("the destination check is answered without storing", () => {
    const body = unpacked(fixture("cloudflare-test.json.gz"))!;
    expect(parseCloudflare(body, H)).toEqual({ ok: true, entries: [], test: true });
  });

  test("Workers trace events: console lines, exceptions, the invocation", () => {
    const entries = entriesOf(parseCloudflare(unpacked(gzipSync(fixture("cloudflare-workers.ndjson")))!, H));
    expect(entries.map((e) => [e.message, e.level])).toEqual([
      ['checkout started {"cart":3}', Level.Info],
      ["coupon expired", Level.Warn],
      ["TypeError: Cannot read properties of undefined (reading 'id')", Level.Error],
      ["POST https://edge.example.com/checkout 500 outcome=exception", Level.Error],
      ["GET https://edge.example.com/ 200 outcome=ok", Level.Info],
    ]);
    expect(entries.every((e) => e.service === "edge-checkout")).toBe(true);
    expect(entries[0].timeNs).toBe(1_794_940_801_005_000_000n);
    expect(parsedLine(entryLine(entries[3]))).toMatchObject({ ray_id: "8e1f1f1f1f1f1f1f", outcome: "exception", status: 500, cpu_ms: 3, wall_ms: 14 });
  });

  test("HTTP requests: service = hostname, status level, unixnano or RFC 3339 times", () => {
    const [a, b] = entriesOf(parseCloudflare(fixture("cloudflare-http.ndjson"), H));
    expect(a).toMatchObject({ message: "GET shop.example.com/products/42 200", level: Level.Info, service: "shop.example.com", timeNs: 1_794_940_803_100_000_000n });
    expect(b).toMatchObject({ level: Level.Error, timeNs: rfc3339Ns("2026-11-17T18:40:03.9Z") });
  });

  test("other datasets: the record as a JSON line", () => {
    const [e] = entriesOf(parseCloudflare(Buffer.from('{"Datetime":"2026-11-17T18:40:00Z","Action":"block","Source":"waf"}\n'), H));
    expect(e).toMatchObject({ level: null, service: null, timeNs: rfc3339Ns("2026-11-17T18:40:00Z") });
    expect(JSON.parse(e.message)).toMatchObject({ Action: "block" });
  });
});

describe("drains through the records pipeline", () => {
  const ctx: EnforceContext = { projectId: "p-1", rows: [], filter: compileFilter([...BUILT_IN_PATTERNS]), deriveErrors: true };

  test("services, hop records under their own service, the filter applied", () => {
    const entries = entriesOf(parseFly(fixture("fly.json"), H));
    entries.push({ message: "card 4111 1111 1111 1111 declined", level: Level.Warn, service: "shop-api", host: "m1", timeNs: null });
    const now = 1_794_940_805_000_000_000n;
    const streams = linesToStreams(entriesToLines(entries, NO_ORIGIN, "fly"), NO_ORIGIN, now);
    const result = enforceStreams(streams, ctx);
    const lines = result.streams.flatMap((s) => s.values.map((v) => lineOf(v[1]) ?? ""));
    expect(result.kept).toBe(5);
    expect(lines.join("\n")).not.toContain("4111 1111 1111 1111");
    expect(result.streams.every((s) => s.stream.service === "shop-api")).toBe(true);
    expect(result.streams[0].values[0][0]).toBe("1794940801123456789");
  });
});
