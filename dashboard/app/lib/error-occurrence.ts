/**
 * Reading a stored occurrence (error_events.payload, error_groups.sample) for the error pages.
 * Payloads are JSON written by three paths over time (reported, log-derived, request-derived;
 * before and after BAC-94), so every field is checked here, once. Client-safe.
 */

export interface OccurrenceView {
  /** The occurrence's line (log-derived), or the reported message. */
  message: string | null;
  /** The exception's own message (BAC-94), or the reported message. */
  errorMessage: string | null;
  stack: string | null;
  traceId: string | null;
  environment: string | null;
}

const TRACE_RE = /^[0-9a-f]{32}$/;

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v : null;
}

/** A payload of any age as the fields the pages show. */
export function readOccurrence(payload: unknown, reported: boolean): OccurrenceView {
  const p: Readonly<Record<string, unknown>> = typeof payload === "object" && payload !== null && !Array.isArray(payload) ? (payload as Record<string, unknown>) : {};
  const message = str(p.message);
  const traceId = str(p.traceId);
  return {
    message,
    // A reported error's message is the exception's own message.
    errorMessage: str(p.errorMessage) ?? (reported ? message : null),
    stack: str(p.stack),
    traceId: traceId && TRACE_RE.test(traceId) ? traceId : null,
    environment: str(p.environment),
  };
}

/** `ReferenceError: partialhead is not defined`, or null when the message is not known. */
export function typeAndMessage(type: string, view: OccurrenceView): string | null {
  return view.errorMessage ? `${type}: ${view.errorMessage}` : null;
}
