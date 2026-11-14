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
 *   SCENARIO  "insights" adds the insights requests (BAC-67) to every cycle: run it
 *             on shop-api, commerce-payments and commerce-risk (see qa/README.md)
 *   REGRESSION_FILE  insights only: once this file exists, GET /shop takes twice as
 *             long (default /tmp/bw-regression; deploy.sh creates it)
 *
 * Run without Docker: SERVICE=commerce-api FORMAT=kv bun qa/fixtures/emitter.ts
 */
import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";

export const Service = {
  Api: "commerce-api",
  Payments: "commerce-payments",
  Risk: "commerce-risk",
  Worker: "commerce-worker",
  /** The insights scenario's storefront (BAC-67). */
  Shop: "shop-api",
} as const;
export type Service = (typeof Service)[keyof typeof Service];

export const Format = { Json: "json", JsonNested: "json-nested", Kv: "kv" } as const;
export type Format = (typeof Format)[keyof typeof Format];

/** Extra request sets a container can add to its cycle. */
export const Scenario = { Insights: "insights" } as const;
export type Scenario = (typeof Scenario)[keyof typeof Scenario];

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
  /** Inbound HTTP hops: the path that was requested (spec 0.10, HOP-24). */
  path?: string;
  /** SQL data-store end records: the table (spec 0.9, section 13.2). */
  table?: string;
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
  /** SQL data-store end records: the statement shape, always written last (spec HOP-14, 13.2). */
  stmt?: string;
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
  "method", "op", "path", "table", "peer", "attempt", "outcome", "status", "error", "duration_us", "db_n", "db_us", "cache_n", "cache_us",
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
  if (rec.stmt !== undefined) out.push(["stmt", rec.stmt]);
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
  apiDb: string; apiOutJob: string; workerIn: string; apiDbMerchant: string;
}

/** IDs of the healthy frame request (frame 2). */
export const FRAME_HEALTHY: HealthyIds = {
  trace: "6503f5f183b828139d5b143365ad72fa", // = SHA-256("correlator:1:F8Zx2o1yQk0AAAEB")[0..16]
  parentId: "b7ad6b7169203331",
  apiIn: "1f0a6c2e9b7d4405", apiOutRisk: "2c51e8a04f9b7d13", riskIn: "a7d03b5e9c2f4816", riskCache: "e19c4d72b05a3f68",
  apiOutPay: "83c2d1907ae45b16", payIn: "5d9e0b3347c1a2f8", payDb1: "b6f20e9d41c7a385", payOutAcq: "4e8a1c73d0b25f96",
  payDb2: "d3071fa5c8e29b40", apiDb: "7b4e92c0a1d5f836", apiOutJob: "0f6d3a8e5b2c7419", workerIn: "c82a5f1e93d047b6",
  apiDbMerchant: "3a9d5e1c7f2b4068",
};

export function randomHealthyIds(): HealthyIds {
  return {
    trace: hex(16), parentId: hex(8),
    apiIn: hex(8), apiOutRisk: hex(8), riskIn: hex(8), riskCache: hex(8), apiOutPay: hex(8), payIn: hex(8),
    payDb1: hex(8), payOutAcq: hex(8), payDb2: hex(8), apiDb: hex(8), apiOutJob: hex(8), workerIn: hex(8),
    apiDbMerchant: hex(8),
  };
}

const us = (ms: number): number => Math.round(ms * 1000);

/** POST /orders: healthy, database and cache calls, a queued job, named fields, linked IDs. */
export function healthyOrder(id: HealthyIds, opts: { status?: number; orderId?: string } = {}): Emission[] {
  const status = opts.status ?? 201;
  const orderId = opts.orderId ?? "7731";
  const A = Service.Api, P = Service.Payments, R = Service.Risk, W = Service.Worker;
  const t = id.trace, pid = id.parentId;
  const apiIn: HopRecord = { trace_id: t, hop: "in", hop_id: id.apiIn, parent_id: pid, service: A, adapter: "plug", via: "http", method: "POST", op: "/orders", path: "/orders" };
  const outRisk: HopRecord = { trace_id: t, hop: "out", hop_id: id.apiOutRisk, parent_hop: id.apiIn, hop_sent: true, parent_id: pid, service: A, adapter: "finch", via: "http", method: "POST", peer: "risk.internal" };
  const riskIn: HopRecord = { trace_id: t, hop: "in", hop_id: id.riskIn, parent_hop: id.apiOutRisk, parent_id: pid, service: R, adapter: "fastify", via: "http", method: "POST", op: "/assess" };
  const riskCache: HopRecord = { trace_id: t, hop: "out_end", hop_id: id.riskCache, parent_hop: id.riskIn, hop_sent: false, parent_id: pid, service: R, adapter: "ioredis", via: "cache", op: "get", peer: "redis.internal", outcome: "ok", duration_us: 400 };
  const outPay: HopRecord = { trace_id: t, hop: "out", hop_id: id.apiOutPay, parent_hop: id.apiIn, hop_sent: true, parent_id: pid, service: A, adapter: "finch", via: "http", method: "POST", peer: "payments.internal" };
  const payIn: HopRecord = { trace_id: t, hop: "in", hop_id: id.payIn, parent_hop: id.apiOutPay, parent_id: pid, service: P, adapter: "hono", via: "http", method: "POST", op: "/charges" };
  // Statement fields as spec 0.9 section 13.2 writes them; payDb1's statement holds `status=?`, which must stay inside stmt.
  const payDb1: HopRecord = { trace_id: t, hop: "out_end", hop_id: id.payDb1, parent_hop: id.payIn, hop_sent: false, parent_id: pid, service: P, adapter: "postgres", via: "db", op: "select", table: "charges", peer: "payments-db", outcome: "ok", duration_us: 1200, stmt: "select c0.id, c0.status from charges as c0 where (c0.order_id = ?) and status=? limit ?" };
  const outAcq: HopRecord = { trace_id: t, hop: "out", hop_id: id.payOutAcq, parent_hop: id.payIn, hop_sent: true, parent_id: pid, service: P, adapter: "fetch", via: "http", method: "POST", peer: "acquirer.example" };
  const payDb2: HopRecord = { ...payDb1, hop_id: id.payDb2, op: "insert", duration_us: 2300, stmt: "insert into charges (order_id, amount, currency, status) values (?) returning id" };
  // The spec's example statement (section 13.2), from Ecto.
  const apiDbMerchant: HopRecord = { trace_id: t, hop: "out_end", hop_id: id.apiDbMerchant, parent_hop: id.apiIn, hop_sent: false, parent_id: pid, service: A, adapter: "ecto", via: "db", op: "select", table: "merchants", peer: "orders-db", outcome: "ok", duration_us: 2600, stmt: "select ... from merchants as m0 where (m0.username = ?) limit ?" };
  const apiDb: HopRecord = { trace_id: t, hop: "out_end", hop_id: id.apiDb, parent_hop: id.apiIn, hop_sent: false, parent_id: pid, service: A, adapter: "ecto", via: "db", op: "insert", table: "orders", peer: "orders-db", outcome: "ok", duration_us: 3800, stmt: "insert into orders (merchant_id, total, currency, inserted_at, updated_at) values (?) returning id" };
  const outJob: HopRecord = { trace_id: t, hop: "out", hop_id: id.apiOutJob, parent_hop: id.apiIn, hop_sent: true, parent_id: pid, service: A, adapter: "oban", via: "job", op: "Receipts.SendEmail", peer: "receipts" };
  const workerIn: HopRecord = { trace_id: t, hop: "in", hop_id: id.workerIn, parent_hop: id.apiOutJob, parent_id: pid, service: W, adapter: "oban", via: "job", op: "Receipts.SendEmail", attempt: 1 };
  const end = (r: HopRecord, x: Partial<HopRecord>): HopRecord => ({ ...r, hop: r.hop === "in" ? "in_end" : "out_end", outcome: "ok", ...x });
  const failed = status >= 400;
  return [
    { at: 0, service: A, kind: "hop", rec: apiIn },
    { at: 1, service: A, kind: "log", level: "info", msg: "order received", trace_id: t },
    { at: 2.9, service: A, kind: "hop", rec: apiDbMerchant },
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
      { at: 61.2, service: A, kind: "hop", rec: end(apiIn, { status, duration_us: 61200, db_n: 2, db_us: 6400 }) } as Emission,
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
  const apiIn: HopRecord = { trace_id: t, hop: "in", hop_id: id.apiIn, parent_id: pid, service: A, adapter: "phoenix", via: "http", method: "POST", op: "/payouts/:id/release", path: "/payouts/po_8Kx2/release" };
  const outPay: HopRecord = { trace_id: t, hop: "out", hop_id: id.apiOutPay, parent_hop: id.apiIn, hop_sent: true, parent_id: pid, service: A, adapter: "finch", via: "http", method: "POST", peer: "payments.internal" };
  const payIn: HopRecord = { trace_id: t, hop: "in", hop_id: id.payIn, parent_hop: id.apiOutPay, parent_id: pid, service: P, adapter: "hono", via: "http", method: "POST", op: "/transfers" };
  const payDb: HopRecord = { trace_id: t, hop: "out_end", hop_id: id.payDb, parent_hop: id.payIn, hop_sent: false, parent_id: pid, service: P, adapter: "postgres", via: "db", op: "select", table: "transfers", peer: "payments-db", outcome: "ok", duration_us: 2100, stmt: "select t0.id, t0.amount, t0.status from transfers as t0 where (t0.payout_id = ?) for update" };
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
// Insights scenario (BAC-67): requests with the patterns the insights features
// find. Every container running SCENARIO=insights derives the same IDs from
// the cycle boundary, so the cross-service requests line up.
// ---------------------------------------------------------------------------

/** Seeded IDs and numbers for one insights cycle. */
export interface InsightsSeed {
  /** 16-hex hop id for a label, the same in every container. */
  id: (label: string) => string;
  /** 32-hex trace id for a request label. */
  trace: (label: string) => string;
  /** A number in [0, 1) for a label, the same in every container. */
  unit: (label: string) => number;
}

export function insightsSeed(seed: number): InsightsSeed {
  const digest = (label: string): string => createHash("sha256").update(`insights:${seed}:${label}`).digest("hex");
  return {
    id: (label) => digest(label).slice(0, 16),
    trace: (label) => digest(`trace:${label}`).slice(0, 32),
    unit: (label) => parseInt(digest(`unit:${label}`).slice(0, 8), 16) / 0x1_0000_0000,
  };
}

/** The N+1 statement: one plan looked up per product on the page. */
export const N_PLUS_ONE_STMT = "select plans.id, plans.name, plans.price from plans where plans.number = ?";
/** Times the N+1 statement runs per GET /shop. */
export const N_PLUS_ONE_REPEATS = 14;
/** The slow statement shape of GET /orders/:id. */
export const SLOW_ORDERS_STMT = "select o0.id, o0.total, o0.status from orders as o0 where (o0.customer_id = ?) order by o0.created_at desc limit ?";
/** Commands in the plain Redis pipeline of GET /feed. */
export const PIPELINE_GETS = 12;

/** The eight distinct selects of GET /shop, one per table. */
const SHOP_SELECTS: readonly { table: string; stmt: string; ms: number }[] = [
  { table: "products", stmt: "select products.id, products.name, products.plan_number from products where products.listed = ? order by products.rank limit ?", ms: 3.2 },
  { table: "categories", stmt: "select categories.id, categories.name from categories where categories.visible = ?", ms: 1.1 },
  { table: "banners", stmt: "select banners.id, banners.image from banners where banners.starts_at <= ? and banners.ends_at > ?", ms: 0.9 },
  { table: "stock", stmt: "select stock.product_id, stock.count from stock where stock.product_id in (?)", ms: 1.8 },
  { table: "prices", stmt: "select prices.product_id, prices.amount from prices where prices.product_id in (?) and prices.currency = ?", ms: 1.6 },
  { table: "reviews", stmt: "select reviews.product_id, avg(reviews.stars) from reviews where reviews.product_id in (?) group by reviews.product_id", ms: 2.4 },
  { table: "carts", stmt: "select carts.id, carts.items from carts where carts.session_id = ?", ms: 0.8 },
  { table: "sessions", stmt: "update sessions set seen_at = ? where sessions.id = ?", ms: 0.7 },
];

type Inbound = { rec: HopRecord; endAt: number; statusCode: number; extra?: Partial<HopRecord> };

function inboundPair(service: Service, start: number, i: Inbound): Emission[] {
  return [
    { at: start, service, kind: "hop", rec: i.rec },
    { at: i.endAt, service, kind: "hop", rec: { ...i.rec, hop: "in_end", outcome: "ok", status: i.statusCode, duration_us: us(i.endAt - start), ...i.extra } },
  ];
}

/** A data-store call written as its end record at `endAt` (store hops have no start record). */
function storeCall(service: Service, base: Omit<HopRecord, "hop" | "hop_id" | "duration_us" | "outcome">, hopId: string, endAt: number, ms: number): Emission {
  return { at: endAt, service, kind: "hop", rec: { ...base, hop: "out_end", hop_id: hopId, hop_sent: false, outcome: "ok", duration_us: us(ms) } };
}

/**
 * GET /shop: the N+1. One request that runs the plans lookup 14 times one after another (one per
 * product) plus 8 distinct selects. `slow` doubles every call (the regression mode).
 */
export function shopList(s: InsightsSeed, slow: boolean): Emission[] {
  const S = Service.Shop;
  const t = s.trace("shop");
  const pid = s.id("shop:pid");
  const inId = s.id("shop:in");
  const k = slow ? 2 : 1;
  const db = { trace_id: t, parent_hop: inId, parent_id: pid, service: S, adapter: "prisma", via: "db" as Via, peer: "shop-db" };
  const out: Emission[] = [{ at: 1.2, service: S, kind: "log", level: "info", msg: "listing products page=1", trace_id: t }];
  let at = 1.5 * k;
  let dbUs = 0;
  const first = SHOP_SELECTS[0];
  at += first.ms * k;
  out.push(storeCall(S, { ...db, op: "select", table: first.table, stmt: first.stmt }, s.id("shop:sel:0"), at, first.ms * k));
  dbUs += us(first.ms * k);
  for (let n = 0; n < N_PLUS_ONE_REPEATS; n++) {
    const ms = (0.9 + 0.5 * s.unit(`shop:plan:${n}`)) * k;
    at += 0.15 + ms;
    out.push(storeCall(S, { ...db, op: "select", table: "plans", stmt: N_PLUS_ONE_STMT }, s.id(`shop:plan:${n}`), at, ms));
    dbUs += us(ms);
  }
  for (let n = 1; n < SHOP_SELECTS.length; n++) {
    const q = SHOP_SELECTS[n];
    at += 0.15 + q.ms * k;
    out.push(storeCall(S, { ...db, op: q.stmt.startsWith("update") ? "update" : "select", table: q.table, stmt: q.stmt }, s.id(`shop:sel:${n}`), at, q.ms * k));
    dbUs += us(q.ms * k);
  }
  const endAt = at + 2.4 * k;
  const rec: HopRecord = { trace_id: t, hop: "in", hop_id: inId, parent_id: pid, service: S, adapter: "fastify", via: "http", method: "GET", op: "/shop", path: "/shop" };
  return [...inboundPair(S, 0, { rec, endAt, statusCode: 200, extra: { db_n: N_PLUS_ONE_REPEATS + SHOP_SELECTS.length, db_us: dbUs } }), ...out];
}

/**
 * GET /orders/:id: one slow query shape (180 to 420 ms), then three independent cache gets run
 * one after another that could have run together.
 */
export function orderLookup(s: InsightsSeed): Emission[] {
  const S = Service.Shop;
  const t = s.trace("order");
  const pid = s.id("order:pid");
  const inId = s.id("order:in");
  const slowMs = 180 + 240 * s.unit("order:slow");
  const orderNo = 5000 + Math.floor(1000 * s.unit("order:no"));
  const db = { trace_id: t, parent_hop: inId, parent_id: pid, service: S, adapter: "prisma", via: "db" as Via, peer: "shop-db" };
  const cache = { trace_id: t, parent_hop: inId, parent_id: pid, service: S, adapter: "ioredis", via: "cache" as Via, peer: "redis.internal", op: "get" };
  let at = 2 + slowMs;
  const out: Emission[] = [storeCall(S, { ...db, op: "select", table: "orders", stmt: SLOW_ORDERS_STMT }, s.id("order:db"), at, slowMs)];
  const gets = [0.6, 0.8, 0.5];
  gets.forEach((ms, n) => {
    at += 0.3 + ms;
    out.push(storeCall(S, cache, s.id(`order:get:${n}`), at, ms));
  });
  out.push({ at: at + 0.2, service: S, kind: "log", level: "info", msg: `order ${orderNo} loaded`, trace_id: t });
  const endAt = at + 1.1;
  const rec: HopRecord = { trace_id: t, hop: "in", hop_id: inId, parent_id: pid, service: S, adapter: "fastify", via: "http", method: "GET", op: "/orders/:id", path: `/orders/${orderNo}` };
  const cacheUs = gets.reduce((a, ms) => a + us(ms), 0);
  return [...inboundPair(S, 0, { rec, endAt, statusCode: 200, extra: { db_n: 1, db_us: us(slowMs), cache_n: gets.length, cache_us: cacheUs } }), ...out];
}

/** GET /feed: a plain Redis pipeline of 12 gets sent in one write. Must not be flagged as N+1 or
 *  as calls that could run in parallel: they already did. */
export function cacheFeed(s: InsightsSeed): Emission[] {
  const S = Service.Shop;
  const t = s.trace("feed");
  const pid = s.id("feed:pid");
  const inId = s.id("feed:in");
  const cache = { trace_id: t, parent_hop: inId, parent_id: pid, service: S, adapter: "ioredis", via: "cache" as Via, peer: "redis.internal", op: "get" };
  const out: Emission[] = [];
  let cacheUs = 0;
  for (let n = 0; n < PIPELINE_GETS; n++) {
    // One write, replies in order: every command started at 1.0 ms and ended a little later.
    const ms = 0.7 + 0.02 * n;
    out.push(storeCall(S, cache, s.id(`feed:get:${n}`), 1.0 + ms, ms));
    cacheUs += us(ms);
  }
  const rec: HopRecord = { trace_id: t, hop: "in", hop_id: inId, parent_id: pid, service: S, adapter: "fastify", via: "http", method: "GET", op: "/feed", path: "/feed" };
  return [...inboundPair(S, 0, { rec, endAt: 3.4, statusCode: 200, extra: { cache_n: PIPELINE_GETS, cache_us: cacheUs } }), ...out];
}

/**
 * POST /checkout: two outbound HTTP calls, to commerce-payments and then commerce-risk, run one
 * after the other although neither needs the other's answer.
 */
export function checkout(s: InsightsSeed): Emission[] {
  const S = Service.Shop, P = Service.Payments, R = Service.Risk;
  const t = s.trace("checkout");
  const pid = s.id("checkout:pid");
  const inId = s.id("checkout:in");
  const outPay: HopRecord = { trace_id: t, hop: "out", hop_id: s.id("checkout:out:pay"), parent_hop: inId, hop_sent: true, parent_id: pid, service: S, adapter: "undici", via: "http", method: "POST", peer: "payments.internal" };
  const payIn: HopRecord = { trace_id: t, hop: "in", hop_id: s.id("checkout:pay:in"), parent_hop: outPay.hop_id, parent_id: pid, service: P, adapter: "hono", via: "http", method: "POST", op: "/charges/authorise" };
  const outRisk: HopRecord = { trace_id: t, hop: "out", hop_id: s.id("checkout:out:risk"), parent_hop: inId, hop_sent: true, parent_id: pid, service: S, adapter: "undici", via: "http", method: "POST", peer: "risk.internal" };
  const riskIn: HopRecord = { trace_id: t, hop: "in", hop_id: s.id("checkout:risk:in"), parent_hop: outRisk.hop_id, parent_id: pid, service: R, adapter: "fastify", via: "http", method: "POST", op: "/screen" };
  const rec: HopRecord = { trace_id: t, hop: "in", hop_id: inId, parent_id: pid, service: S, adapter: "fastify", via: "http", method: "POST", op: "/checkout", path: "/checkout" };
  const payMs = 38 + 20 * s.unit("checkout:pay");
  const riskMs = 24 + 16 * s.unit("checkout:risk");
  const payStart = 2.0, payEnd = payStart + payMs;
  const riskStart = payEnd + 0.8, riskEnd = riskStart + riskMs;
  return [
    ...inboundPair(S, 0, { rec, endAt: riskEnd + 1.5, statusCode: 201 }),
    { at: 0.6, service: S, kind: "log", level: "info", msg: "checkout started", trace_id: t },
    { at: payStart, service: S, kind: "hop", rec: outPay },
    ...inboundPair(P, payStart + 0.4, { rec: payIn, endAt: payEnd - 0.4, statusCode: 200 }),
    { at: payEnd, service: S, kind: "hop", rec: { ...outPay, hop: "out_end", outcome: "ok", status: 200, duration_us: us(payMs) } },
    { at: riskStart, service: S, kind: "hop", rec: outRisk },
    ...inboundPair(R, riskStart + 0.4, { rec: riskIn, endAt: riskEnd - 0.4, statusCode: 200 }),
    { at: riskEnd, service: S, kind: "hop", rec: { ...outRisk, hop: "out_end", outcome: "ok", status: 200, duration_us: us(riskMs) } },
  ];
}

/** Every request of one insights cycle, spaced a second apart. */
export function insightsCycle(seed: number, regression: boolean): Emission[] {
  const s = insightsSeed(seed);
  const shift = (list: Emission[], ms: number): Emission[] => list.map((e) => ({ ...e, at: e.at + ms }));
  return [
    ...shift(shopList(s, regression), 0),
    ...shift(orderLookup(s), 1000),
    ...shift(cacheFeed(s), 2000),
    ...shift(checkout(s), 3000),
  ];
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
function isScenario(v: string): v is Scenario {
  return (Object.values(Scenario) as string[]).includes(v);
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
  const scenario = process.env.SCENARIO ?? "";
  if (scenario && !isScenario(scenario)) throw new Error(`SCENARIO must be one of ${Object.values(Scenario).join(", ")}`);
  const regressionFile = process.env.REGRESSION_FILE ?? "/tmp/bw-regression";

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
    if (scenario === Scenario.Insights) schedule(insightsCycle(start, existsSync(regressionFile)), svc, fmt, start + 5000);
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
    apiDbMerchant: h("apiDbMerchant", 8),
  };
}

if (import.meta.main) main();
