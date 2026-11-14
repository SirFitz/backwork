// Hop records (Correlator spec draft 0.8, section 13.1) as the dashboard sees them.
// Fixed sets are `as const` maps with a matching union type, so call sites never repeat
// magic strings. Pure types: no runtime dependency on Loki or Remix.

/** The `hop` field of a record. */
export const HopKind = {
  In: "in",
  InEnd: "in_end",
  Out: "out",
  OutEnd: "out_end",
} as const;
export type HopKind = (typeof HopKind)[keyof typeof HopKind];
export const HOP_KINDS: readonly HopKind[] = Object.values(HopKind);

/** Direction of a hop: arriving at an entry point, or leaving through an exit point. */
export const HopDir = {
  In: "in",
  Out: "out",
} as const;
export type HopDir = (typeof HopDir)[keyof typeof HopDir];

/** The `via` field (HOP-8). */
export const Via = {
  Http: "http",
  Rpc: "rpc",
  Job: "job",
  Message: "message",
  Db: "db",
  Cache: "cache",
  Other: "other",
} as const;
export type Via = (typeof Via)[keyof typeof Via];
export const VIAS: readonly Via[] = Object.values(Via);

/** The `outcome` field of end records (HOP-11). */
export const Outcome = {
  Ok: "ok",
  Error: "error",
} as const;
export type Outcome = (typeof Outcome)[keyof typeof Outcome];
export const OUTCOMES: readonly Outcome[] = Object.values(Outcome);

/** Design 7.3 step 5. */
export const HopState = {
  Finished: "finished",
  Open: "open",
  Stalled: "stalled",
} as const;
export type HopState = (typeof HopState)[keyof typeof HopState];

/** Design 7.4. */
export const GapKind = {
  /** A stalled hop: "Stopped here". */
  Stopped: "stopped",
  /** Outbound, hop_sent true, no child: "No record from <peer>". */
  NoReceiver: "no_receiver",
  /** hop_sent true, no receiver, and the peer has never answered as a service: a third party or
   *  a service without Correlator. Shown, not counted as a gap. */
  NotInstrumented: "not_instrumented",
  /** Outbound, hop_sent false, not a data-store hop: "Not linked". */
  NotLinked: "not_linked",
  /** Inbound with a parent_hop not among this organisation's records: the caller is another
   *  organisation's service, or one whose records were not collected. Told apart only by a
   *  cross-organisation lookup, which the view never makes, so it is a note, not a gap (BAC-55). */
  OutsideCaller: "outside_caller",
  /** parent_id differs from the parent's and the parent has no tracer field. */
  TracerBetween: "tracer_between",
  /** Several inbound hops with the same parent and different attempts: "Retry n". */
  Retry: "retry",
} as const;
export type GapKind = (typeof GapKind)[keyof typeof GapKind];

/** Data-store kind for totals and metrics labels (design 5.3). */
export const StoreKind = {
  Db: "db",
  Cache: "cache",
} as const;
export type StoreKind = (typeof StoreKind)[keyof typeof StoreKind];

/** 32 lowercase hex characters, not all zeros. Only values of this type reach a query. */
export type TraceId = string & { readonly __brand: "TraceId" };
/** 16 lowercase hex characters. */
export type HopId = string & { readonly __brand: "HopId" };

/** A named field (`f_{name}`) on an inbound end record (HOP-21). */
export interface NamedField {
  name: string;
  value: string;
}

/** Data-store totals on an inbound end record (HOP-20). */
export interface StoreTotals {
  dbCalls: number;
  dbUs: number;
  cacheCalls: number;
  cacheUs: number;
}

/** One validated hop record line. Times are epoch milliseconds from the log entry. */
export interface HopRecord {
  traceId: TraceId;
  hop: HopKind;
  hopId: HopId;
  parentHop: HopId | null;
  /** Outbound only; null on inbound records. */
  hopSent: boolean | null;
  /** Outbound only: true when the OpenTelemetry bridge was active (OTEL-11). */
  tracer: boolean;
  /** Outbound only: `handoff=true` (HOP-23), made off the request's path: from a handed-off task,
   *  thread or process, or started after the request ended. False when absent. */
  handoff: boolean;
  parentId: string | null;
  /** The collector's service label, falling back to the record's own `service`. */
  /** The service the record names (its own `service` field, spec HOP-8); what every page shows. */
  service: string;
  /** Where the line came from: the collector's container or process name (Loki label `source`,
   *  or `service` on records stored before BAC-49). Ordinary log lines carry only this name, so
   *  it joins them to the hop's service. Null when the label is missing. */
  source: string | null;
  adapter: string | null;
  via: Via;
  method: string | null;
  op: string | null;
  /** Inbound HTTP hops: the path that was requested, long segments masked (spec HOP-24). `op`
   *  stays the route template: group by `op`, show `path` for one request. */
  path: string | null;
  /** Inbound HTTP hops: the request's host, lower case, no port (spec 0.13, HOP-27). Missing or
   *  null when not recorded (records before 0.13). */
  host?: string | null;
  /** Inbound hops: `synthetic=1` (HOP-28), an uptime monitor's request or one downstream of it.
   *  Missing or false when not marked. */
  synthetic?: boolean;
  peer: string | null;
  /** SQL data-store hops: the table the statement acts on (spec 13.2, STM-5), when recorded. */
  table: string | null;
  /** SQL data-store hops: the statement's shape, values replaced by `?` (STM-3, STM-4). */
  stmt: string | null;
  attempt: number | null;
  outcome: Outcome | null;
  status: number | null;
  error: string | null;
  durationUs: number | null;
  totals: StoreTotals | null;
  fields: NamedField[];
  /** Log entry time, epoch ms. */
  timeMs: number;
}

/** A linked ID line (LOG-5). */
export interface LinkedId {
  traceId: TraceId;
  name: string;
  value: string;
  hopId: HopId | null;
  service: string;
  timeMs: number;
}

/** An ordinary log line holding the trace ID. */
export interface TraceLogLine {
  service: string;
  level: string | null;
  timeMs: number;
  line: string;
}

export interface Gap {
  kind: GapKind;
  /** The hop the gap is attached to. */
  hopId: HopId;
  /** Display text, e.g. "No record from payments.internal". */
  label: string;
  /** Retry number for GapKind.Retry, peer for NoReceiver. */
  detail: string | null;
}

/** Calls under an inbound hop that passed the record limit (HOP-19), design 7.3 step 8. */
export interface UnrecordedStoreCalls {
  store: StoreKind;
  calls: number;
  us: number;
}

/** Redis commands that open and close a MULTI block (BAC-63). */
export const BlockOp = {
  Multi: "multi",
  Exec: "exec",
  Discard: "discard",
} as const;
export type BlockOp = (typeof BlockOp)[keyof typeof BlockOp];

/** A MULTI ... EXEC block whose command records were drawn as one hop (BAC-63). */
export interface StorePipeline {
  /** The commands, MULTI first and EXEC (or DISCARD) last. */
  ops: readonly string[];
  /** The commands' own durations added up: what the request's totals counted for them. */
  commandUs: number;
}

export interface Hop {
  hopId: HopId;
  dir: HopDir;
  via: Via;
  service: string;
  adapter: string | null;
  method: string | null;
  op: string | null;
  /** Inbound HTTP hops: the path that was requested (HOP-24), when recorded. */
  path: string | null;
  /** Inbound HTTP hops: the request's host (HOP-27), when recorded. */
  host?: string | null;
  /** Inbound hops marked `synthetic=1` (HOP-28): a monitor's request. */
  synthetic?: boolean;
  peer: string | null;
  /** SQL data-store hops (spec 13.2): table and statement shape, when recorded. */
  table: string | null;
  stmt: string | null;
  parentHop: HopId | null;
  parentId: string | null;
  hopSent: boolean | null;
  tracer: boolean;
  /** HOP-23 `handoff=true` on either record: shown as "background", out of the time split. */
  handoff: boolean;
  attempt: number | null;
  state: HopState;
  outcome: Outcome | null;
  status: number | null;
  error: string | null;
  /** Start time, epoch ms (end time minus duration for data-store hops). */
  startMs: number;
  endMs: number | null;
  durationUs: number | null;
  totals: StoreTotals | null;
  fields: NamedField[];
  linkedIds: LinkedId[];
  logs: TraceLogLine[];
  gaps: Gap[];
  unrecorded: UnrecordedStoreCalls[];
  /** True for `via` db or cache. */
  isStore: boolean;
  /** Set when this hop stands for a whole MULTI block: one call, its commands listed here. */
  pipeline: StorePipeline | null;
  /** An outbound call that ended after its inbound hop's end record: it ran on after the response
   *  was sent. Drawn where it ran and left out of "where the time went". */
  afterResponse: boolean;
  /** Milliseconds this hop's start was moved later because its records put it before its parent's
   *  start, which cannot happen (clock difference, a late start record, or queue time in the
   *  duration). 0 when not moved. */
  skewMs: number;
  children: Hop[];
}

/** Where the time went for the first inbound hop (design 7.3 step 10), microseconds. */
export interface TimeSplit {
  totalUs: number;
  /** Wall-clock time in the database: the union of its calls, not their sum. */
  dbUs: number;
  /** Wall-clock time in the cache beyond the database time. */
  cacheUs: number;
  /** Wall-clock time waiting on other services beyond the database and cache time. */
  waitingUs: number;
  /** The rest: never negative; the parts add up to totalUs. */
  ownUs: number;
  dbCalls: number;
  /** The calls' durations added up; more than dbUs when calls overlapped. */
  dbSumUs: number;
  cacheCalls: number;
  cacheSumUs: number;
  /** Calls marked `handoff=true` (HOP-23): not part of the request's time; their durations added up. */
  backgroundCalls: number;
  backgroundUs: number;
}

export interface RequestTree {
  traceId: TraceId;
  roots: Hop[];
  /** Every hop, flat, in start order. */
  hops: Hop[];
  linkedIds: LinkedId[];
  gaps: Gap[];
  /** Log lines that fit no inbound hop, by service. */
  unplacedLogs: Record<string, TraceLogLine[]>;
  split: TimeSplit | null;
  startMs: number | null;
  endMs: number | null;
  services: string[];
}

/** Hop records are kept 30 days (design 6). */
export const HOP_RETENTION_DAYS = 30;
/** Ordinary log lines are kept 7 days. */
export const LOG_RETENTION_DAYS = 7;
/** Log lines in the request view load this many at a time (design 13). */
export const LOG_PAGE = 1000;

/** The progressive search windows of design 7.2 step 1. */
export const SearchWindow = {
  Hour: "hour",
  Day: "day",
  Retention: "retention",
} as const;
export type SearchWindow = (typeof SearchWindow)[keyof typeof SearchWindow];

export const WINDOW_LABEL: Record<SearchWindow, string> = {
  [SearchWindow.Hour]: "the last hour",
  [SearchWindow.Day]: "the last 24 hours",
  [SearchWindow.Retention]: `the last ${HOP_RETENTION_DAYS} days`,
};
