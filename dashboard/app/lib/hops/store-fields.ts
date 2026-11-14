// Pure. Data-store field names on hop records (spec HOP-20, and the proposed HOP-25 and HOP-26 of
// docs/insights/12-cache-and-pool.md), shared by the parser, the ingest proxy and the collector
// config so the Database and cache switch removes the same fields in every place.

/** Store fields of hop records: inbound totals and the per-call fields of end records. */
export const StoreField = {
  DbCalls: "db_n",
  DbUs: "db_us",
  /** Proposed HOP-26: microseconds the request's database calls waited for a connection. */
  DbWaitUs: "db_wait_us",
  CacheCalls: "cache_n",
  CacheUs: "cache_us",
  /** Proposed HOP-25: one-key cache reads that found a value. */
  CacheHits: "cache_hit_n",
  /** Proposed HOP-25: one-key cache reads that found nothing. */
  CacheMisses: "cache_miss_n",
  /** Proposed HOP-25, cache end records: whether the read found a value. */
  Hit: "hit",
  /** Proposed HOP-26, database end records: microseconds of the duration spent waiting for a connection. */
  WaitUs: "wait_us",
} as const;
export type StoreField = (typeof StoreField)[keyof typeof StoreField];

/** The inbound end record's totals, removed when the Database and cache switch is off. The per-call
 *  fields need no rule: the whole data-store line is dropped then. */
export const STORE_TOTAL_FIELDS: readonly StoreField[] = [
  StoreField.DbCalls,
  StoreField.DbUs,
  StoreField.DbWaitUs,
  StoreField.CacheCalls,
  StoreField.CacheUs,
  StoreField.CacheHits,
  StoreField.CacheMisses,
];

/** Regex source (JS and Rust-regex alike) matching ` <total>=<value>` in a key=value line. */
export const STORE_TOTALS_KV_PATTERN = " (?:db|cache)_(?:n|us|hit_n|miss_n|wait_us)=\\S*";
