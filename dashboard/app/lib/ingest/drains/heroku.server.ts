/**
 * Heroku HTTPS log drains (https://devcenter.heroku.com/articles/log-drains): Logplex posts
 * `application/logplex-1` bodies, syslog messages (RFC 5424 without STRUCTURED-DATA) framed by
 * octet counting (RFC 6587 3.4.1): `<length> <message>`, the length in bytes. Authenticated by
 * HTTP Basic from the drain URL's user info (the token as the password). Logplex wants an empty
 * 200 (Content-Length: 0, no body).
 *
 * Heroku does not send the app name (HOSTNAME is "host", APP-NAME is "app" for app output and
 * "heroku" for the platform's own lines), so service comes from ?service=. host = PROCID (the dyno,
 * web.1, or router); time = TIMESTAMP. App lines keep their text and the collector reads their
 * level; router lines take at=info|warning|error; platform errors (Error R14, crashed) are errors.
 */
import { Level, rfc3339Ns } from "~/lib/ingest/records.server";
import { levelWord, parsed, type DrainEntry, type DrainParser } from "./entry.server";

/** The APP-NAME values Heroku writes. */
export const HerokuAppName = { App: "app", Heroku: "heroku" } as const;
export type HerokuAppName = (typeof HerokuAppName)[keyof typeof HerokuAppName];

/** Request headers Logplex sends. */
export const LogplexHeader = { MsgCount: "logplex-msg-count", FrameId: "logplex-frame-id", DrainToken: "logplex-drain-token" } as const;

const SPACE = 0x20;
const SYSLOG_RE = /^<(\d{1,3})>(\d{1,2}) (\S+) (\S+) (\S+) (\S+) (\S+)(?: ([\s\S]*))?$/;

/** The syslog messages in an octet-counted body. Falls back to one message per line when the
 *  framing does not hold (a body that is plain syslog lines). */
export function octetFrames(body: Buffer): string[] {
  const out: string[] = [];
  let pos = 0;
  while (pos < body.length) {
    while (pos < body.length && (body[pos] === 0x0a || body[pos] === 0x0d || body[pos] === SPACE)) pos++;
    if (pos >= body.length) break;
    let end = pos;
    while (end < body.length && end - pos < 9 && body[end] >= 0x30 && body[end] <= 0x39) end++;
    if (end === pos || body[end] !== SPACE) {
      return [...out, ...body.subarray(pos).toString("utf8").split(/\r?\n/).filter((l) => l.trim() !== "")];
    }
    const len = Number(body.subarray(pos, end).toString("ascii"));
    const start = end + 1;
    out.push(body.subarray(start, Math.min(start + len, body.length)).toString("utf8").replace(/\r?\n$/, ""));
    pos = start + len;
  }
  return out;
}

function routerLevel(msg: string): Level {
  return levelWord(/\bat=(\w+)/.exec(msg)?.[1] ?? null) ?? Level.Info;
}

export function herokuEntry(frame: string): DrainEntry | null {
  const m = SYSLOG_RE.exec(frame);
  if (!m) return frame.trim() === "" ? null : { message: frame, level: null, service: null, host: null, timeNs: null };
  const [, , , ts, , app, procid, , msg = ""] = m;
  let level: Level | null = null;
  if (app === HerokuAppName.Heroku) {
    if (procid === "router") level = routerLevel(msg);
    else if (/^Error [A-Z]\d+/.test(msg) || /\bcrashed\b/.test(msg)) level = Level.Error;
  }
  return {
    message: msg,
    level,
    service: null,
    host: procid === "-" ? null : procid,
    timeNs: rfc3339Ns(ts),
    fields: { dyno: procid, source: app },
  };
}

export const parseHeroku: DrainParser = (body) =>
  parsed(octetFrames(body).map(herokuEntry).filter((e): e is DrainEntry => e !== null));
