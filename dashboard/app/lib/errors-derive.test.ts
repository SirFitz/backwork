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

// BAC-94: the real Courier Portal block (reportError, errorreporter.js:126) after the collector joined it.
const CP_BLOCK = [
  "[error] Uncaught in GET /help | GET /help | company 12 | user 34",
  "ReferenceError: /app/views/pages/help.ejs:1",
  " >> 1| <%- include(partialhead); %>",
  '    2| <script src="https://www.google.com/recaptcha/api.js"></script>',
  "    3| <script>",
  "",
  "partialhead is not defined",
  "    at eval (/app/views/pages/help.ejs:10:25)",
  "    at help (/app/node_modules/ejs/lib/ejs.js:691:17)",
  "    at tryHandleCache (/app/node_modules/ejs/lib/ejs.js:272:36)",
  'extra: {"route":"/help"} trace_id=e2b146c09e2c8027f37cb280ed949389',
].join("\n");

const API_BLOCK = [
  "[error] GET /login | GET /login | API GET http://api:3000/api/company/get/byclientdomain/x -> ECONNREFUSED",
  "ApiError: GET /company/get/byclientdomain/:id failed: ECONNREFUSED",
  "    at /app/routes/routes.web.js:118:9",
  "    at process.processTicksAndRejections (node:internal/process/task_queues:105:5) trace_id=9f1525b762a0cf80ecd25c085077dc63",
].join("\n");

describe("multi-line error entries (BAC-94)", () => {
  test("the Courier Portal block: type, the template's message, excerpt + stack; title is the header as before", () => {
    const e = log(CP_BLOCK)!;
    const header = log("[error] Uncaught in GET /help | GET /help | company 12 | user 34")!;
    expect(e.title).toBe(header.title);
    expect(e.fingerprint).toBe(header.fingerprint);
    expect(e.type).toBe("ReferenceError");
    expect(e.errorMessage).toBe("partialhead is not defined");
    expect(e.message).toBe("[error] Uncaught in GET /help | GET /help | company 12 | user 34");
    expect(e.stack).toBe(
      [
        "in /app/views/pages/help.ejs:1",
        " >> 1| <%- include(partialhead); %>",
        '    2| <script src="https://www.google.com/recaptcha/api.js"></script>',
        "    3| <script>",
        "",
        "    at eval (/app/views/pages/help.ejs:10:25)",
        "    at help (/app/node_modules/ejs/lib/ejs.js:691:17)",
        "    at tryHandleCache (/app/node_modules/ejs/lib/ejs.js:272:36)",
      ].join("\n"),
    );
  });
  test("an ApiError / ECONNREFUSED block: name, message, frames without the appended trace id", () => {
    const e = log(API_BLOCK)!;
    expect(e.type).toBe("ApiError");
    expect(e.errorMessage).toBe("GET /company/get/byclientdomain/:id failed: ECONNREFUSED");
    expect(e.stack).toBe("    at /app/routes/routes.web.js:118:9\n    at process.processTicksAndRejections (node:internal/process/task_queues:105:5)");
    expect(e.title).toBe(log(API_BLOCK.split("\n")[0])!.title);
  });
  test("TypeError, AggregateError and Error [CODE] names", () => {
    expect(log("[error] x\nTypeError: Cannot read properties of undefined (reading 'id')\n    at /a.js:1:2")!.type).toBe("TypeError");
    expect(log("[error] x\nAggregateError: all failed\n    at /a.js:1:2")!.type).toBe("AggregateError");
    const c = log("[error] x\nError [ERR_HTTP_HEADERS_SENT]: Cannot set headers\n    at /a.js:1:2")!;
    expect(c.type).toBe("Error");
    expect(c.errorMessage).toBe("Cannot set headers");
  });
  test("a pino JSON line: err.stack becomes the stack, err.message the message, msg stays the title", () => {
    const line = JSON.stringify({
      level: 50, msg: "request failed",
      err: { type: "TypeError", message: "x is not a function", stack: "TypeError: x is not a function\n    at handler (/srv/app.js:4:9)\n    at next (/srv/router.js:1:1)" },
    });
    const e = log(line, null)!;
    expect(e.title).toBe("request failed");
    expect(e.type).toBe("TypeError");
    expect(e.errorMessage).toBe("x is not a function");
    expect(e.stack).toBe("    at handler (/srv/app.js:4:9)\n    at next (/srv/router.js:1:1)");
  });
  test("a one-line error is unchanged: type Error, the line as message, no stack", () => {
    const e = log("[error] Sending email | company 26")!;
    expect(e.type).toBe("Error");
    expect(e.message).toBe("[error] Sending email | company 26");
    expect(e.errorMessage).toBeNull();
    expect(e.stack).toBeNull();
    expect(e.title).toBe("Sending email | company <n>");
  });
  test("a multi-line entry without a Name: line keeps type Error", () => {
    const e = log("[error] Sending email | company 26\nextra: {\"provider\":\"smtp\"}")!;
    expect(e.type).toBe("Error");
    expect(e.stack).toBeNull();
    expect(e.title).toBe("Sending email | company <n>");
  });
});
