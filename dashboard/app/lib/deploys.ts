// Deploy reports (BAC-73, insights plan 06 section B). Pure: the shape a CI job posts to
// `POST /ingest/deploys`, its validation, and how a deploy is labelled on a chart. Storage is in
// deploys.server.ts.

/** Deploys accepted in one call. */
export const MAX_DEPLOYS_PER_CALL = 20;
/** A reported time may be at most this far ahead of the server clock. */
export const MAX_FUTURE_MS = 5 * 60_000;
/** Calls per project per hour before the endpoint answers 429. */
export const DEPLOY_RATE_LIMIT_CALLS = 60;
export const DEPLOY_RATE_LIMIT_WINDOW_MS = 60 * 60_000;
/** Longest accepted text per field, in characters. */
export const MAX_SERVICE_CHARS = 200;
export const MAX_FIELD_CHARS = 200;
export const MAX_URL_CHARS = 2000;
/** Characters of a commit shown when there is no version. */
export const SHORT_COMMIT_CHARS = 7;

/** One deploy as a CI job reports it. */
export interface DeployReport {
  service: string;
  version?: string;
  commit?: string;
  environment?: string;
  url?: string;
  actor?: string;
  /** ISO 8601; defaults to the time of the call */
  at?: string;
}

/** A report after validation: `at` resolved to ms, absent fields null. */
export interface ValidDeploy {
  service: string;
  version: string | null;
  commit: string | null;
  environment: string | null;
  url: string | null;
  actor: string | null;
  atMs: number;
}

/** A stored deploy, as the pages and the read API see it. */
export interface Deploy {
  id: string;
  projectId: string | null;
  service: string;
  version: string | null;
  commit: string | null;
  environment: string | null;
  url: string | null;
  actor: string | null;
  /** ms */
  deployedAt: number;
}

export type ParseResult = { ok: true; deploys: ValidDeploy[] } | { ok: false; error: string };

const OPTIONAL_FIELDS = ["version", "commit", "environment", "url", "actor"] as const;
type OptionalField = (typeof OPTIONAL_FIELDS)[number];
const FIELD_LIMIT: Record<OptionalField, number> = {
  version: MAX_FIELD_CHARS,
  commit: MAX_FIELD_CHARS,
  environment: MAX_FIELD_CHARS,
  url: MAX_URL_CHARS,
  actor: MAX_FIELD_CHARS,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Printable text without control characters. */
function isPlainText(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return false;
  }
  return true;
}

/** A service name as hop records carry it: 1 to 200 bytes in 0x21..0x7E (spec HOP-12). */
function isServiceName(value: string): boolean {
  if (value.length < 1 || value.length > MAX_SERVICE_CHARS) return false;
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c < 0x21 || c > 0x7e) return false;
  }
  return true;
}

function validateOne(item: unknown, index: number, nowMs: number): ValidDeploy | string {
  const where = `deploys[${index}]`;
  if (!isRecord(item)) return `${where}: expected an object`;
  const service = typeof item.service === "string" ? item.service.trim() : null;
  if (service === null || !isServiceName(service)) return `${where}.service: required, 1 to ${MAX_SERVICE_CHARS} printable characters without spaces`;
  const out: ValidDeploy = { service, version: null, commit: null, environment: null, url: null, actor: null, atMs: nowMs };
  for (const f of OPTIONAL_FIELDS) {
    const v = item[f];
    if (v === undefined || v === null) continue;
    if (typeof v !== "string") return `${where}.${f}: expected a string`;
    const t = v.trim();
    if (!t) continue;
    if (t.length > FIELD_LIMIT[f] || !isPlainText(t)) return `${where}.${f}: at most ${FIELD_LIMIT[f]} printable characters`;
    out[f] = t;
  }
  if (out.url !== null && !/^https?:\/\//i.test(out.url)) return `${where}.url: expected an http or https address`;
  if (item.at !== undefined && item.at !== null) {
    if (typeof item.at !== "string") return `${where}.at: expected an ISO 8601 time`;
    const ms = Date.parse(item.at);
    if (!Number.isFinite(ms)) return `${where}.at: expected an ISO 8601 time`;
    if (ms > nowMs + MAX_FUTURE_MS) return `${where}.at: more than ${MAX_FUTURE_MS / 60_000} minutes in the future`;
    out.atMs = ms;
  }
  return out;
}

/** Validate a body: one report, or `{ deploys: [...] }` with 1 to 20 reports. Fields other than
 *  those of `DeployReport` are ignored. */
export function parseDeployPayload(body: unknown, nowMs: number): ParseResult {
  let items: unknown[];
  if (isRecord(body) && "deploys" in body) {
    if (!Array.isArray(body.deploys)) return { ok: false, error: "deploys: expected an array" };
    items = body.deploys;
  } else if (isRecord(body)) {
    items = [body];
  } else {
    return { ok: false, error: "expected a deploy object or { deploys: [...] }" };
  }
  if (!items.length) return { ok: false, error: "deploys: empty list" };
  if (items.length > MAX_DEPLOYS_PER_CALL) return { ok: false, error: `deploys: at most ${MAX_DEPLOYS_PER_CALL} per call, got ${items.length}` };
  const deploys: ValidDeploy[] = [];
  for (let i = 0; i < items.length; i++) {
    const r = validateOne(items[i], i, nowMs);
    if (typeof r === "string") return { ok: false, error: r };
    deploys.push(r);
  }
  return { ok: true, deploys };
}

/** The label of a deploy marker: the version, else the short commit, else "deploy". */
export function markerLabel(d: Pick<Deploy, "version" | "commit">): string {
  if (d.version) return d.version;
  if (d.commit) return d.commit.slice(0, SHORT_COMMIT_CHARS);
  return "deploy";
}

/** Hover text of a marker: label, who and when (UTC). */
export function markerDetail(d: Pick<Deploy, "version" | "commit" | "actor" | "environment" | "deployedAt">): string {
  const when = new Date(d.deployedAt).toISOString().slice(0, 16).replace("T", " ");
  const parts = [`deploy ${markerLabel(d)}`];
  if (d.commit && d.version) parts.push(`commit ${d.commit.slice(0, SHORT_COMMIT_CHARS)}`);
  if (d.actor) parts.push(`by ${d.actor}`);
  if (d.environment) parts.push(d.environment);
  parts.push(`${when} UTC`);
  return parts.join(", ");
}
