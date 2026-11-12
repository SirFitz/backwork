/**
 * Fixture emitter: writes spec-exact Correlator hop records (spec 13.1),
 * link lines (LOG-5) and ordinary log lines to stdout, for one service of the
 * two sample requests in the design frames.
 *
 * TEST USE ONLY (design section 14): never run this against a backwork that
 * real users look at.
 *
 * One container per service runs this with SERVICE set; the collector names
 * the service after the container, as it would for a real service. All
 * containers agree on a shared wall-clock schedule (cycle boundaries), so the
 * cross-service timing of each request is real.
 *
 *   SERVICE   commerce-api | commerce-payments | commerce-risk | commerce-worker
 *   FORMAT    json (pino style, top level) | json-nested (fields under "metadata")
 *             | kv (key=value with a timestamp and level in front)
 *   CYCLE_S   seconds between generated requests (default 30)
 *   FIXED     "1" (default) emits the two frame requests with their fixed IDs once
 *   SENSITIVE "1" (default) emits one line per cycle holding a card number,
 *             an email and a member number (for the sensitive-data filter test)
 *
 * Run without Docker: SERVICE=commerce-api FORMAT=kv bun qa/fixtures/emitter.ts
 */
import { createHash, randomBytes } from "node:crypto";

export const Service = {
  Api: "commerce-api",
  Payments: "commerce-payments",
  Risk: "commerce-risk",
  Worker: "commerce-worker",
} as const;
export type Service = (typeof Service)[keyof typeof Service];

export const Format = { Json: "json", JsonNested: "json-nested", Kv: "kv" } as const;
export type Format = (typeof Format)[keyof typeof Format];

export type HopKind = "in" | "in_end" | "out" | "out_end";
export type Via = "http" | "rpc" | "job" | "message" | "db" | "cache" | "other";
export type Outcome = "ok" | "error";

/** One hop record, fields in the order of spec HOP-8. */
export interface HopRecord {
  trace_id: string;
  hop: HopKind;
  hop_id: string;
  parent_hop?: string;
  hop_sent?: boolean;
  tracer?: boolean;
  parent_id: string;
  service?: string;
  adapter: string;
  via: Via;
  method?: string;
  op?: string;
  peer?: string;
  attempt?: number;
  outcome?: Outcome;
  status?: number;
  error?: string;
  duration_us?: number;
  db_n?: number;
  db_us?: number;
  cache_n?: number;
  cache_us?: number;
  /** f_{name} named fields, in insertion order. */
  fields?: Record<string, string>;
}

export interface LinkLine {
  trace_id: string;
  link_name: string;
  link_value: string;
  hop_id?: string;
}

export type Level = "info" | "warn" | "error" | "debug";

/** What a service writes at an offset (ms) from the start of a request. */
export type Emission =
  | { at: number; service: Service; kind: "hop"; rec: HopRecord }
  | { at: number; service: Service; kind: "link"; link: LinkLine }
  | { at: number; service: Service; kind: "log"; level: Level; msg: string; trace_id?: string };

const FIELD_ORDER: readonly (keyof HopRecord)[] = [
  "trace_id", "hop", "hop_id", "parent_hop", "hop_sent", "tracer", "parent_id", "service", "adapter", "via",
  "method", "op", "peer", "attempt", "outcome", "status", "error", "duration_us", "db_n", "db_us", "cache_n", "cache_us",
];

/** Ordered [key, value] pairs of a record, exactly as HOP-8/HOP-14 list them. */
export function recordPairs(rec: HopRecord): [string, string | number | boolean][] {
  const out: [string, string | number | boolean][] = [];
  for (const k of FIELD_ORDER) {
    const v = rec[k];
    if (v === undefined || typeof v === "object") continue;
    out.push([k, v as string | number | boolean]);
  }
  for (const [n, v] of Object.entries(rec.fields ?? {})) out.push([`f_${n}`, v]);
  return out;
}

const LEVEL_NUM: Record<Level, number> = { debug: 20, info: 30, warn: 40, error: 50 };

function clock(d: Date): string {
  return d.toISOString().slice(11, 23);
}

/** Render one emission as a log line in the given format. */
export function render(e: Emission, format: Format, now: Date): string {
  const pairs: [string, string | number | boolean][] =
    e.kind === "hop" ? recordPairs(e.rec)
    : e.kind === "link" ? ([["trace_id", e.link.trace_id], ["link_name", e.link.link_name], ["link_value", e.link.link_value],
        ...(e.link.hop_id ? [["hop_id", e.link.hop_id]] : [])] as [string, string][])
    : e.trace_id ? [["trace_id", e.trace_id]] : [];
  const level: Level = e.kind === "log" ? e.level : "info";
  const msg = e.kind === "hop" ? "hop" : e.kind === "link" ? "linked" : e.msg;
  if (format === Format.Kv) {
    // Elixir console style: "<time> [level] <message>". Hop and link lines are
    // the key=value message of HOP-14; ordinary lines carry trace_id= (LOG-6).
    const kv = pairs.map(([k, v]) => `${k}=${v}`).join(" ");
    const body = e.kind === "log" ? (kv ? `${e.msg} ${kv}` : e.msg) : kv;
    return `${clock(now)} [${level}] ${body}`;
  }
  const obj: Record<string, unknown> = Object.fromEntries(pairs);
  if (format === Format.JsonNested) {
    return JSON.stringify({ time: now.toISOString(), severity: level, message: msg, metadata: obj });
  }
  return JSON.stringify({ level: LEVEL_NUM[level], time: now.getTime(), pid: 1, hostname: "fixture", ...obj, msg });
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

export function hex(bytes: number): string {
  return randomBytes(bytes).toString("hex");
}

export interface HealthyIds {
  trace: string;
  parentId: string;
  apiIn: string; apiOutRisk: string; riskIn: string; riskCache: string;
  apiOutPay: string; payIn: string; payDb1: string; payOutAcq: string; payDb2: string;
  apiDb: string; apiOutJob: string; workerIn: string;
}

/** IDs of the healthy frame request (frame 2). */
export const FRAME_HEALTHY: HealthyIds = {
  trace: "6503f5f183b828139d5b143365ad72fa", // = SHA-256("correlator:1:F8Zx2o1yQk0AAAEB")[0..16]
  parentId: "b7ad6b7169203331",
  apiIn: "1f0a6c2e9b7d4405", apiOutRisk: "2c51e8a04f9b7d13", riskIn: "a7d03b5e9c2f4816", riskCache: "e19c4d72b05a3f68",
  apiOutPay: "83c2d1907ae45b16", payIn: "5d9e0b3347c1a2f8", payDb1: "b6f20e9d41c7a385", payOutAcq: "4e8a1c73d0b25f96",
  payDb2: "d3071fa5c8e29b40", apiDb: "7b4e92c0a1d5f836", apiOutJob: "0f6d3a8e5b2c7419", workerIn: "c82a5f1e93d047b6",
};

export function randomHealthyIds(): HealthyIds {
  return {
    trace: hex(16), parentId: hex(8),
    apiIn: hex(8), apiOutRisk: hex(8), riskIn: hex(8), riskCache: hex(8), apiOutPay: hex(8), payIn: hex(8),
    payDb1: hex(8), payOutAcq: hex(8), payDb2: hex(8), apiDb: hex(8), apiOutJob: hex(8), workerIn: hex(8),
  };
}

const us = (ms: number): number => Math.round(ms * 1000);

/** POST /orders: healthy, database and cache calls, a queued job, named fields, linked IDs. */
export function healthyOrder(id: HealthyIds, opts: { status?: number; orderId?: string } = {}): Emission[] {
  const status = opts.status ?? 201;
  const orderId = opts.orderId ?? "7731";
  const A = Service.Api, P = Service.Payments, R = Service.Risk, W = Service.Worker;
  const t = id.trace, pid = id.parentId;
  const apiIn: HopRecord = { trace_id: t, hop: "in", hop_id: id.apiIn, parent_id: pid, service: A, adapter: "plug", via: "http", method: "POST", op: "/orders" };
  const outRisk: HopRecord = { trace_id: t, hop: "out", hop_id: id.apiOutRisk, parent_hop: id.apiIn, hop_sent: true, parent_id: pid, service: A, adapter: "finch", via: "http", method: "POST", peer: "risk.internal" };
  const riskIn: HopRecord = { trace_id: t, hop: "in", hop_id: id.riskIn, parent_hop: id.apiOutRisk, parent_id: pid, service: R, adapter: "fastify", via: "http", method: "POST", op: "/assess" };
  const riskCache: HopRecord = { trace_id: t, hop: "out_end", hop_id: id.riskCache, parent_hop: id.riskIn, hop_sent: false, parent_id: pid, service: R, adapter: "ioredis", via: "cache", op: "get", peer: "redis.internal", outcome: "ok", duration_us: 400 };
  const outPay: HopRecord = { trace_id: t, hop: "out", hop_id: id.apiOutPay, parent_hop: id.apiIn, hop_sent: true, parent_id: pid, service: A, adapter: "finch", via: "http", method: "POST", peer: "payments.internal" };
  const payIn: HopRecord = { trace_id: t, hop: "in", hop_id: id.payIn, parent_hop: id.apiOutPay, parent_id: pid, service: P, adapter: "hono", via: "http", method: "POST", op: "/charges" };
  const payDb1: HopRecord = { trace_id: t, hop: "out_end", hop_id: id.payDb1, parent_hop: id.payIn, hop_sent: false, parent_id: pid, service: P, adapter: "postgres", via: "db", op: "select", peer: "payments-db", outcome: "ok", duration_us: 1200 };
  const outAcq: HopRecord = { trace_id: t, hop: "out", hop_id: id.payOutAcq, parent_hop: id.payIn, hop_sent: true, parent_id: pid, service: P, adapter: "fetch", via: "http", method: "POST", peer: "acquirer.example" };
  const payDb2: HopRecord = { ...payDb1, hop_id: id.payDb2, op: "insert", duration_us: 2300 };
  const apiDb: HopRecord = { trace_id: t, hop: "out_end", hop_id: id.apiDb, parent_hop: id.apiIn, hop_sent: false, parent_id: pid, service: A, adapter: "ecto", via: "db", op: "insert", peer: "orders-db", outcome: "ok", duration_us: 3800 };
  const outJob: HopRecord = { trace_id: t, hop: "out", hop_id: id.apiOutJob, parent_hop: id.apiIn, hop_sent: true, parent_id: pid, service: A, adapter: "oban", via: "job", op: "Receipts.SendEmail", peer: "receipts" };
  const workerIn: HopRecord = { trace_id: t, hop: "in", hop_id: id.workerIn, parent_hop: id.apiOutJob, parent_id: pid, service: W, adapter: "oban", via: "job", op: "Receipts.SendEmail", attempt: 1 };
  const end = (r: HopRecord, x: Partial<HopRecord>): HopRecord => ({ ...r, hop: r.hop === "in" ? "in_end" : "out_end", outcome: "ok", ...x });
  const failed = status >= 400;
  return [
    { at: 0, service: A, kind: "hop", rec: apiIn },
    { at: 1, service: A, kind: "log", level: "info", msg: "order received", trace_id: t },
    { at: 3.1, service: A, kind: "hop", rec: outRisk },
    { at: 3.4, service: R, kind: "hop", rec: riskIn },
    { at: 4.3, service: R, kind: "hop", rec: riskCache },
    { at: 10.9, service: R, kind: "log", level: "info", msg: "assessment ok score=12", trace_id: t },
    { at: 11.3, service: R, kind: "hop", rec: end(riskIn, { status: 200, duration_us: 7900, cache_n: 1, cache_us: 400 }) },
    { at: 11.5, service: A, kind: "hop", rec: end(outRisk, { status: 200, duration_us: 8400 }) },
    ...(failed ? [
      { at: 9.1, service: A, kind: "hop", rec: end(apiIn, { status, duration_us: 9100 }) } as Emission,
    ] : [
      { at: 14.0, service: A, kind: "hop", rec: outPay } as Emission,
      { at: 14.2, service: P, kind: "hop", rec: payIn } as Emission,
      { at: 15.0, service: P, kind: "log", level: "info", msg: "charge requested amount=4500 currency=JMD", trace_id: t } as Emission,
      { at: 15.8, service: P, kind: "hop", rec: payDb1 } as Emission,
      { at: 16.0, service: P, kind: "hop", rec: outAcq } as Emission,
      { at: 16.1, service: P, kind: "log", level: "info", msg: "acquirer call started", trace_id: t } as Emission,
      { at: 27.1, service: P, kind: "log", level: "info", msg: "acquirer approved auth=A91K20", trace_id: t } as Emission,
      { at: 27.2, service: P, kind: "hop", rec: end(outAcq, { status: 200, duration_us: 11200 }) } as Emission,
      { at: 27.3, service: P, kind: "link", link: { trace_id: t, link_name: "acquirer_ref", link_value: "A91K20", hop_id: id.payIn } } as Emission,
      { at: 28.5, service: P, kind: "log", level: "info", msg: `charge stored id=ch_${orderId}`, trace_id: t } as Emission,
      { at: 29.5, service: P, kind: "hop", rec: payDb2 } as Emission,
      { at: 29.0 + 0.6, service: P, kind: "hop", rec: end(payIn, { status: 201, duration_us: 14800, db_n: 2, db_us: 3500, fields: { order_id: orderId, currency: "JMD" } }) } as Emission,
      { at: 29.8, service: A, kind: "hop", rec: end(outPay, { status: 201, duration_us: 15300 }) } as Emission,
      { at: 47.0, service: A, kind: "link", link: { trace_id: t, link_name: "order_id", link_value: orderId, hop_id: id.apiIn } } as Emission,
      { at: 51.4, service: A, kind: "hop", rec: apiDb } as Emission,
      { at: 52.0, service: A, kind: "hop", rec: outJob } as Emission,
      { at: 53.1, service: A, kind: "hop", rec: end(outJob, { duration_us: 1100 }) } as Emission,
      { at: 61.2, service: A, kind: "hop", rec: end(apiIn, { status, duration_us: 61200, db_n: 1, db_us: 3800 }) } as Emission,
      { at: 2353, service: W, kind: "hop", rec: workerIn } as Emission,
      { at: 2500, service: W, kind: "log", level: "info", msg: "receipt email queued for delivery", trace_id: t } as Emission,
      { at: 2765, service: W, kind: "hop", rec: end(workerIn, { duration_us: 412000 }) } as Emission,
    ]),
  ];
}

export interface StalledIds {
  trace: string; parentId: string;
  apiIn: string; apiOutPay: string; payIn: string; payDb: string; payOutBank: string; apiOutJob: string;
}

/** IDs of the stalled frame request (frame 3). */
export const FRAME_STALLED: StalledIds = {
  trace: "9c2f41d07be3a6158d04f2c7b91e60aa",
  parentId: "e4b1c9a07d36f252",
  apiIn: "3b7e0d9a15c4f628", apiOutPay: "6a2d8f4c0e19b357", payIn: "9a3e5d7710c2b4f6", payDb: "f07b3c61e8d2a945",
  payOutBank: "c41f7a0be2d95638", apiOutJob: "58e9a2d64b0c1f73",
};

/**
 * POST /payouts/:id/release: commerce-payments stops waiting on the bank
 * gateway (open inbound hop, stalled outbound hop with no end record),
 * commerce-api times out after 30 s, and a queued notification job has no
 * receiver (`hop_sent` true, no inbound record).
 */
export function stalledPayout(id: StalledIds): Emission[] {
  const A = Service.Api, P = Service.Payments;
  const t = id.trace, pid = id.parentId;
  const apiIn: HopRecord = { trace_id: t, hop: "in", hop_id: id.apiIn, parent_id: pid, service: A, adapter: "phoenix", via: "http", method: "POST", op: "/payouts/:id/release" };
  const outPay: HopRecord = { trace_id: t, hop: "out", hop_id: id.apiOutPay, parent_hop: id.apiIn, hop_sent: true, parent_id: pid, service: A, adapter: "finch", via: "http", method: "POST", peer: "payments.internal" };
  const payIn: HopRecord = { trace_id: t, hop: "in", hop_id: id.payIn, parent_hop: id.apiOutPay, parent_id: pid, service: P, adapter: "hono", via: "http", method: "POST", op: "/transfers" };
  const payDb: HopRecord = { trace_id: t, hop: "out_end", hop_id: id.payDb, parent_hop: id.payIn, hop_sent: false, parent_id: pid, service: P, adapter: "postgres", via: "db", op: "select", peer: "payments-db", outcome: "ok", duration_us: 2100 };
  const outBank: HopRecord = { trace_id: t, hop: "out", hop_id: id.payOutBank, parent_hop: id.payIn, hop_sent: true, parent_id: pid, service: P, adapter: "fetch", via: "http", method: "POST", peer: "bank-gw.internal" };
  const outJob: HopRecord = { trace_id: t, hop: "out", hop_id: id.apiOutJob, parent_hop: id.apiIn, hop_sent: true, parent_id: pid, service: A, adapter: "oban", via: "job", op: "Notifications.PayoutDelayed", peer: "notifications" };
  return [
    { at: 0, service: A, kind: "hop", rec: apiIn },
    { at: 2, service: A, kind: "link", link: { trace_id: t, link_name: "payout_id", link_value: "PO-88213", hop_id: id.apiIn } },
    { at: 180, service: A, kind: "hop", rec: outPay },
    { at: 360, service: P, kind: "hop", rec: payIn },
    { at: 372, service: P, kind: "hop", rec: payDb },
    { at: 380, service: P, kind: "hop", rec: outBank },
    { at: 381, service: P, kind: "log", level: "info", msg: "bank transfer submitted ref=TRF-88213", trace_id: t },
    { at: 6387, service: P, kind: "log", level: "warn", msg: "bank gateway slow, still waiting (6s)", trace_id: t },
    { at: 12839, service: P, kind: "log", level: "warn", msg: "bank gateway slow, still waiting (12s)", trace_id: t },
    { at: 30180, service: A, kind: "hop", rec: { ...outPay, hop: "out_end", outcome: "error", error: "Mint.TransportError", duration_us: 30000000 } },
    { at: 30185, service: A, kind: "log", level: "error", msg: "payout release failed: payments timed out", trace_id: t },
    { at: 30186, service: A, kind: "hop", rec: outJob },
    { at: 30187, service: A, kind: "hop", rec: { ...outJob, hop: "out_end", outcome: "ok", duration_us: 900 } },
    { at: 30200, service: A, kind: "hop", rec: { ...apiIn, hop: "in_end", outcome: "ok", status: 504, duration_us: 30020000 } },
  ];
}

/** Lines with no trace ID, and the sensitive-data probe line. */
export function ordinaryLines(service: Service, sensitive: boolean): Emission[] {
  const out: Emission[] = [
    { at: 0, service, kind: "log", level: "info", msg: "GET /healthz 200 0.4ms" },
  ];
  if (sensitive && service === Service.Api) {
    out.push({
      at: 5, service, kind: "log", level: "info",
      msg: "customer contact updated card=4111 1111 1111 1111 email=jane.doe@example.com member=MBR-123456 phone=+18765551234",
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

function isService(v: string): v is Service {
  return (Object.values(Service) as string[]).includes(v);
}
function isFormat(v: string): v is Format {
  return (Object.values(Format) as string[]).includes(v);
}

function schedule(list: Emission[], service: Service, format: Format, startMs: number): void {
  for (const e of list) {
    if (e.service !== service) continue;
    const delay = Math.max(0, startMs + e.at - Date.now());
    setTimeout(() => process.stdout.write(render(e, format, new Date()) + "\n"), delay);
  }
}

function main(): void {
  const svc = process.env.SERVICE ?? "";
  const fmt = process.env.FORMAT ?? Format.Json;
  if (!isService(svc)) throw new Error(`SERVICE must be one of ${Object.values(Service).join(", ")}`);
  if (!isFormat(fmt)) throw new Error(`FORMAT must be one of ${Object.values(Format).join(", ")}`);
  const cycleMs = Math.max(5, Number(process.env.CYCLE_S ?? "30")) * 1000;
  const fixed = (process.env.FIXED ?? "1") === "1";
  const sensitive = (process.env.SENSITIVE ?? "1") === "1";

  // First boundary: every container started by one `compose up` agrees on it.
  let boundary = Math.ceil(Date.now() / cycleMs) * cycleMs;
  if (boundary - Date.now() < 5000) boundary += cycleMs;
  if (fixed) {
    schedule(healthyOrder(FRAME_HEALTHY), svc, fmt, boundary);
    schedule(stalledPayout(FRAME_STALLED), svc, fmt, boundary);
  }
  const tick = (start: number): void => {
    // Generated requests share the boundary as their seed so every container
    // derives the same IDs without talking to the others.
    const ids = seededHealthyIds(start);
    const status = (start / cycleMs) % 5 === 4 ? 422 : 201;
    schedule(healthyOrder(ids, { status, orderId: String(8000 + (start / cycleMs) % 1000) }), svc, fmt, start + 1000);
    schedule(ordinaryLines(svc, sensitive), svc, fmt, start + 500);
    setTimeout(() => tick(start + cycleMs), Math.max(0, start + cycleMs - Date.now()));
  };
  tick(boundary + cycleMs);
}

/** Deterministic IDs from a boundary time, so every service container agrees. */
export function seededHealthyIds(seed: number): HealthyIds {
  const h = (label: string, bytes: number): string =>
    createHash("sha256").update(`fixture:${seed}:${label}`).digest("hex").slice(0, bytes * 2);
  return {
    trace: h("trace", 16), parentId: h("pid", 8),
    apiIn: h("apiIn", 8), apiOutRisk: h("apiOutRisk", 8), riskIn: h("riskIn", 8), riskCache: h("riskCache", 8),
    apiOutPay: h("apiOutPay", 8), payIn: h("payIn", 8), payDb1: h("payDb1", 8), payOutAcq: h("payOutAcq", 8),
    payDb2: h("payDb2", 8), apiDb: h("apiDb", 8), apiOutJob: h("apiOutJob", 8), workerIn: h("workerIn", 8),
  };
}

if (import.meta.main) main();
