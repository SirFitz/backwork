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
