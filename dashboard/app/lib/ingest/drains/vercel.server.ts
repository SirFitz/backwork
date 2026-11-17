/**
 * Vercel log drains (https://vercel.com/docs/drains/reference/logs): a JSON array or NDJSON of
 * log objects, up to 1 MB a post. Authenticated by a custom header (Authorization: Bearer) set on
 * the drain. Vercel also signs each body (x-vercel-signature, HMAC-SHA1 with a secret Vercel
 * generates); backwork does not store that secret, the bearer token is the check.
 *
 * service = projectName (else projectId); host = executionRegion (or the proxy's region; "build"
 * for build logs); level = level (warning -> warn); time = timestamp (ms). A request log with no
 * message gets "METHOD host+path status". Request, trace and span IDs go into the line.
 */
import { Level } from "~/lib/ingest/records.server";
import { jsonObjects, levelWord, msNs, num, obj, parsed, str, unreadable, type DrainEntry, type DrainParser, type EntryFields } from "./entry.server";

/** Vercel's log sources. */
export const VercelSource = { Build: "build", Edge: "edge", Lambda: "lambda", Static: "static", External: "external", Firewall: "firewall", Redirect: "redirect" } as const;
export type VercelSource = (typeof VercelSource)[keyof typeof VercelSource];

function requestSummary(proxy: Record<string, unknown>): string | null {
  const method = str(proxy, "method");
  const host = str(proxy, "host") ?? "";
  if (!method) return null;
  const status = num(proxy, "statusCode");
  const cache = str(proxy, "vercelCache");
  return [method, `${host}${str(proxy, "path") ?? ""}`, status === null ? null : String(status), cache].filter((x) => x !== null && x !== "").join(" ");
}

export function vercelEntry(o: Record<string, unknown>): DrainEntry | null {
  const proxy = obj(o, "proxy");
  const message = str(o, "message") ?? (proxy ? requestSummary(proxy) : null);
  if (message === null) return null;
  const source = str(o, "source");
  const status = num(o, "statusCode") ?? (proxy ? num(proxy, "statusCode") : null);
  const fields: EntryFields = {};
  const put = (k: string, v: string | number | null): void => {
    if (v !== null && v !== "") fields[k] = v;
  };
  put("source", source);
  put("type", str(o, "type"));
  put("request_id", str(o, "requestId"));
  put("trace_id", str(o, "traceId"));
  put("span_id", str(o, "spanId"));
  put("status", status);
  put("path", (proxy ? str(proxy, "path") : null) ?? str(o, "path"));
  put("deployment", str(o, "deploymentId"));
  put("environment", str(o, "environment"));
  const level = levelWord(str(o, "level")) ?? Level.Info;
  return {
    message,
    level,
    service: str(o, "projectName") ?? str(o, "projectId"),
    host: source === VercelSource.Build ? "build" : (str(o, "executionRegion") ?? (proxy ? str(proxy, "region") : null)),
    timeNs: msNs(num(o, "timestamp")),
    fields,
  };
}

export const parseVercel: DrainParser = (body) => {
  const objects = jsonObjects(body.toString("utf8"));
  if (objects === null) return unreadable("body is not a JSON array or NDJSON of Vercel log objects");
  return parsed(objects.map(vercelEntry).filter((e): e is DrainEntry => e !== null));
};
