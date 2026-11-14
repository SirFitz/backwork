// Fixed sets and shapes of "what needs attention" (attention.server.ts), shared with the
// Overview page component. Pure, so nothing server-only reaches the browser bundle.
import type { TraceId } from "~/lib/hops/types";

/** Rows shown per list. */
export const LIST_LIMIT = 10;

export const JumpKind = {
  Errors: "errors",
  Latency: "latency",
} as const;
export type JumpKind = (typeof JumpKind)[keyof typeof JumpKind];

export interface ServiceWindow {
  service: string;
  requests: number;
  failed: number;
  /** seconds, null without samples */
  p95: number | null;
}

export interface ServiceJump {
  service: string;
  kind: JumpKind;
  requests: number;
  /** errors: share 0..1; latency: seconds */
  now: number;
  /** null when the service had no traffic before the window */
  before: number | null;
}

export interface StalledRequest {
  traceId: TraceId;
  service: string;
  method: string | null;
  op: string | null;
  startMs: number;
}

export interface UnreceivedCall {
  traceId: TraceId;
  service: string;
  peer: string | null;
  method: string | null;
  op: string | null;
  endMs: number;
  failed: boolean;
}

export interface RecordScan<T> {
  rows: T[];
  /** total matching before the list limit */
  total: number;
  /** the record limit was reached, so older records in the window were not read */
  truncated: boolean;
}

/** The Overview's "Needs attention" groups, in page order (BAC-73 adds Regressions). */
export const AttentionGroup = {
  Jumps: "jumps",
  Regressions: "regressions",
  Stalled: "stalled",
  Unreceived: "unreceived",
} as const;
export type AttentionGroup = (typeof AttentionGroup)[keyof typeof AttentionGroup];
export const ATTENTION_GROUPS: readonly AttentionGroup[] = Object.values(AttentionGroup);

/** A deploy this long before the compared window's start, or later, is named next to a regression. */
export const REGRESSION_DEPLOY_LOOKBACK_MS = 6 * 3600_000;

/** One service slower or failing more than the same hour last week, for the Overview. */
export interface ServiceRegression {
  service: string;
  /** compare.ts verdict: slower or more_errors */
  verdict: "slower" | "more_errors";
  requests: number;
  /** seconds */
  p95Now: number | null;
  p95Before: number | null;
  p95Ratio: number | null;
  /** 0..1 */
  errorNow: number;
  errorBefore: number;
  /** the newest deploy of the service in the window or the 6 hours before it, ms */
  deployAt: number | null;
  deployLabel: string | null;
}
