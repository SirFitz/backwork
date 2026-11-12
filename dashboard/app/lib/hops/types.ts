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
  /** Inbound with a parent_hop not among the records: "Caller's record missing". */
  MissingCaller: "missing_caller",
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
  peer: string | null;
  /** SQL data-store hops (spec 13.2): table and statement shape, when recorded. */
  table: string | null;
  stmt: string | null;
  parentHop: HopId | null;
  parentId: string | null;
  hopSent: boolean | null;
  tracer: boolean;
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
  children: Hop[];
}

/** Where the time went for the first inbound hop (design 7.3 step 10), microseconds. */
export interface TimeSplit {
  totalUs: number;
  dbUs: number;
  cacheUs: number;
  waitingUs: number;
  ownUs: number;
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
