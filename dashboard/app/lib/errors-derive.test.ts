import { describe, expect, test } from "bun:test";
import { ErrorLevel, ErrorSource, fromHopEnd, fromLogLine, normaliseMessage, normalisePath, toLogLevel } from "./errors-derive";

const log = (line: string, level: unknown = "error", service = "courier-portal-client") =>
  fromLogLine({ line, service, level, traceId: null, at: 0 });

describe("normaliseMessage", () => {
  test("the same failure with different ids, numbers, ips, times and quoted values is one title", () => {
    const a = normaliseMessage(`[error] payment 4812 failed for order 0f8fad5b-d9cb-469f-a165-70867728950e from 10.0.3.7:5432 at 2026-11-15T22:01:03.120Z: "card declined"`);
    const b = normaliseMessage(`[error] payment 77 failed for order 7c9e6679-7425-40de-944b-e07fc1f90ae7 from 172.16.0.21:6543 at 2026-11-16T01:12:44Z: "insufficient funds"`);
    expect(a).toBe(b);
    expect(a).toBe(`payment <n> failed for order <uuid> from <ip> at <time>: "<str>"`);
  });
  test("trace ids, hex, random file names and e-mails", () => {
    expect(normaliseMessage("Uncaught in POST /RSC/mh3605y3mbzshuo.txt")).toBe(normaliseMessage("Uncaught in POST /RSC/5j42raitcsgjeak.txt"));
    expect(normaliseMessage("trace e0978af03ea4612a53785910fa14e971 ptr 0xdeadbeef")).toBe("trace <id> ptr <hex>");
    expect(normaliseMessage("no user jane@example.com")).toBe("no user <email>");
  });
  test("different failures stay different", () => {
    expect(normaliseMessage("Uncaught in GET /register")).not.toBe(normaliseMessage("Uncaught in GET /about"));
    expect(normaliseMessage("connection refused")).not.toBe(normaliseMessage("connection reset"));
  });
  test("strips a leading level tag and terminal colours, keeps words", () => {
    expect(normaliseMessage("\u001b[31m[ERROR]\u001b[39m  db timeout")).toBe("db timeout");
    expect(normaliseMessage("Error: boom")).toBe("boom");
  });
});

describe("fromLogLine", () => {
  test("only error and fatal levels, from a label or the line itself", () => {
    expect(log("boom", "error")?.level).toBe(ErrorLevel.Error);
    expect(log("boom", "fatal")?.level).toBe(ErrorLevel.Fatal);
    expect(log("boom", "warn")).toBeNull();
    expect(log("boom", "info")).toBeNull();
    expect(log("boom", null)).toBeNull();
    expect(log(JSON.stringify({ level: 50, msg: "db down" }), null)?.title).toBe("db down");
    expect(log(JSON.stringify({ level: 60, msg: "dying" }), null)?.level).toBe(ErrorLevel.Fatal);
    expect(log(JSON.stringify({ level: 30, msg: "fine" }), null)).toBeNull();
  });
  test("same failure, different ids → same fingerprint; other service or message → different", () => {
    const a = log("[error] Uncaught in POST /webhook | company 97")!;
    const b = log("[error] Uncaught in POST /webhook | company 1203")!;
    expect(a.fingerprint).toBe(b.fingerprint);
    expect(a.source).toBe(ErrorSource.Log);
    expect(log("[error] Uncaught in POST /webhook | company 97", "error", "courier-portal-api")!.fingerprint).not.toBe(a.fingerprint);
    expect(log("[error] Uncaught in GET /about")!.fingerprint).not.toBe(a.fingerprint);
  });
  test("error name from pino err, trace id kept only when valid", () => {
    const e = fromLogLine({ line: JSON.stringify({ level: "error", msg: "x", err: { type: "TypeError", message: "x" } }), service: "s", level: null, traceId: "e0978af03ea4612a53785910fa14e971", at: 5 })!;
    expect(e.type).toBe("TypeError");
    expect(e.traceId).toBe("e0978af03ea4612a53785910fa14e971");
    expect(fromLogLine({ line: "boom", service: "s", level: "error", traceId: "nope", at: 0 })!.traceId).toBeNull();
  });
  test("level aliases", () => {
    expect(toLogLevel("ERROR")).toBe("error");
    expect(toLogLevel("critical")).toBe("fatal");
    expect(toLogLevel(40)).toBe("warn");
    expect(toLogLevel("chatty")).toBeNull();
  });
});

const hop = (f: Record<string, unknown>, pathsOn = true) =>
  fromHopEnd({ fields: { hop: "in_end", trace_id: "e0978af03ea4612a53785910fa14e971", via: "http", ...f }, service: "svc", pathsOn, at: 0 });

describe("fromHopEnd", () => {
  test("5xx only", () => {
    expect(hop({ status: "500", method: "POST", op: "/x" })).not.toBeNull();
    expect(hop({ status: 503, method: "GET", op: "/x" })?.title).toBe("GET /x → 503");
    expect(hop({ status: "404", method: "GET", op: "/x" })).toBeNull();
    expect(hop({ status: "200", method: "GET", op: "/x" })).toBeNull();
    expect(hop({ method: "GET", op: "/x" })).toBeNull();
    expect(fromHopEnd({ fields: { hop: "in", status: "500" }, service: "s", pathsOn: true, at: 0 })).toBeNull();
  });
  test("grouped by service + method + route template; op wins over the path", () => {
    const a = hop({ status: "500", method: "POST", op: "/xapi/api/GetUsers", path: "/xapi/api/GetUsers?x=1" })!;
    const b = hop({ status: "502", method: "post", op: "/xapi/api/GetUsers", path: "/xapi/api/GetUsers?x=2" })!;
    expect(a.fingerprint).toBe(b.fingerprint);
    expect(a.type).toBe("HTTP 500");
    expect(a.traceId).toBe("e0978af03ea4612a53785910fa14e971");
    expect(hop({ status: "500", method: "GET", op: "/xapi/api/GetUsers" })!.fingerprint).not.toBe(a.fingerprint);
    expect(hop({ status: "500", method: "POST", op: "/xapi/api/Other" })!.fingerprint).not.toBe(a.fingerprint);
    expect(hop({ status: "500", method: "POST", op: "/xapi/api/GetUsers", service: "other" })!.fingerprint).not.toBe(a.fingerprint);
  });
  test("without op, the path with ids replaced; without paths, an unknown route", () => {
    const a = hop({ status: "500", method: "POST", path: "/RSC/mh3605y3mbzshuo.txt" })!;
    const b = hop({ status: "500", method: "POST", path: "/RSC/5j42raitcsgjeak.txt" })!;
    expect(a.fingerprint).toBe(b.fingerprint);
    expect(a.title).toBe("POST /RSC/:id.txt → 500");
    expect(normalisePath("/orders/1234/items/0f8fad5b-d9cb-469f-a165-70867728950e")).toBe("/orders/:n/items/:id");
    expect(hop({ status: "500", method: "POST", path: "/secret/42" }, false)!.route).toBe("(unknown route)");
  });
});
