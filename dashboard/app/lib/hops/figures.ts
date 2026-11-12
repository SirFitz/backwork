// Fixed sets shared by the Performance page and `metrics.server.ts`. Pure, so the route
// component (client code) can use them; `metrics.server.ts` re-exports them.

/** The Performance page's one range control (frame 5). */
export const PerfRange = {
  H1: "1h",
  H6: "6h",
  H24: "24h",
  D7: "7d",
} as const;
export type PerfRange = (typeof PerfRange)[keyof typeof PerfRange];
export const PERF_RANGES: readonly PerfRange[] = Object.values(PerfRange);
export const DEFAULT_RANGE: PerfRange = PerfRange.H6;

/** How a connection's destination is shown (design 9, phase 3). */
export const PeerKind = {
  /** The peer is the name of a service that reports hops. */
  Service: "service",
  Database: "database",
  Cache: "cache",
  /** A host or queue name not matched to a service yet. */
  Unmatched: "unmatched",
} as const;
export type PeerKind = (typeof PeerKind)[keyof typeof PeerKind];
