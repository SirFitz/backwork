// Search input -> trace ID (design 7.1, spec ID-4, TP-1..TP-5). Pure.
// Only the 32 lowercase hex characters this returns ever reach a query.
import { createHash } from "node:crypto";
import type { TraceId } from "./types";

/** Which rule turned the input into a trace ID. */
export const IdRule = {
  /** 32 hex characters (spec ID-4 rule 1). */
  Hex: "hex",
  /** A UUID (spec ID-4 rule 2). */
  Uuid: "uuid",
  /** A full W3C traceparent value: its trace ID part. */
  Traceparent: "traceparent",
  /** Any other valid value, through SHA-256 (spec ID-4 rule 3). */
  Derived: "derived",
} as const;
export type IdRule = (typeof IdRule)[keyof typeof IdRule];

export const IdRejection = {
  Empty: "empty",
  TooLong: "too_long",
  BadCharacter: "bad_character",
  /** Rule 3 yielded all zeros (ID-5). */
  ZeroResult: "zero_result",
} as const;
export type IdRejection = (typeof IdRejection)[keyof typeof IdRejection];

export type TraceIdResult =
  | { ok: true; traceId: TraceId; rule: IdRule; input: string }
  | { ok: false; reason: IdRejection; message: string };

/** Plain correlation value limit (spec section 5). */
export const MAX_ID_BYTES = 200;
const DERIVE_PREFIX = "correlator:1:";

const REJECT_MESSAGES: Record<IdRejection, string> = {
  [IdRejection.Empty]: "Paste a trace ID, a request ID, a UUID or a full traceparent.",
  [IdRejection.TooLong]: `That value is longer than ${MAX_ID_BYTES} characters, so it cannot be a request ID.`,
  [IdRejection.BadCharacter]: "That value holds spaces or characters a request ID cannot hold.",
  [IdRejection.ZeroResult]: "That value does not resolve to a trace ID.",
};

function reject(reason: IdRejection): TraceIdResult {
  return { ok: false, reason, message: REJECT_MESSAGES[reason] };
}

function isHexCode(c: number): boolean {
  return (c >= 48 && c <= 57) || (c >= 97 && c <= 102) || (c >= 65 && c <= 70);
}
function isLowerHexCode(c: number): boolean {
  return (c >= 48 && c <= 57) || (c >= 97 && c <= 102);
}

/** Every character is hex (either case), no regex (VAL-2). */
function allHex(s: string, from: number, to: number, lowerOnly: boolean): boolean {
  for (let i = from; i < to; i++) {
    const c = s.charCodeAt(i);
    if (lowerOnly ? !isLowerHexCode(c) : !isHexCode(c)) return false;
  }
  return true;
}

function allZero(s: string): boolean {
  for (let i = 0; i < s.length; i++) if (s[i] !== "0" && s[i] !== "-") return false;
  return true;
}

function isUuid(s: string): boolean {
  if (s.length !== 36) return false;
  for (let i = 0; i < 36; i++) {
    const dash = i === 8 || i === 13 || i === 18 || i === 23;
    const c = s.charCodeAt(i);
    if (dash ? c !== 45 : !isHexCode(c)) return false;
  }
  return true;
}

/** The trace ID of a valid traceparent (TP-1..TP-5), or null. */
export function traceIdFromTraceparent(s: string): TraceId | null {
  if (s.length < 55) return null;
  if (s[2] !== "-" || s[35] !== "-" || s[52] !== "-") return null;
  const version = s.slice(0, 2);
  if (!allHex(version, 0, 2, true) || version === "ff") return null;
  if (version === "00" && s.length !== 55) return null;
  if (version !== "00" && s.length > 55 && s[55] !== "-") return null;
  if (!allHex(s, 3, 35, true) || !allHex(s, 36, 52, true) || !allHex(s, 53, 55, true)) return null;
  const trace = s.slice(3, 35);
  const parent = s.slice(36, 52);
  if (allZero(trace) || allZero(parent)) return null;
  return trace as TraceId;
}

function derive(value: string): string {
  return createHash("sha256").update(DERIVE_PREFIX + value, "ascii").digest("hex").slice(0, 32);
}

/** Resolve one search input to a trace ID, or reject it with a message. */
export function toTraceId(raw: string): TraceIdResult {
  const input = raw.trim();
  if (input.length === 0) return reject(IdRejection.Empty);
  // Validation (spec section 5): 1 to 200 bytes, every byte in 0x21-0x7E.
  // Checked per UTF-16 unit; any unit outside 0x21-0x7E is rejected, so length equals bytes.
  for (let i = 0; i < input.length && i <= MAX_ID_BYTES; i++) {
    const c = input.charCodeAt(i);
    if (c < 0x21 || c > 0x7e) return reject(IdRejection.BadCharacter);
  }
  if (input.length > MAX_ID_BYTES) return reject(IdRejection.TooLong);

  if (input.length === 32 && allHex(input, 0, 32, false) && !allZero(input)) {
    return { ok: true, traceId: input.toLowerCase() as TraceId, rule: IdRule.Hex, input };
  }
  if (isUuid(input) && !allZero(input)) {
    return { ok: true, traceId: input.replace(/-/g, "").toLowerCase() as TraceId, rule: IdRule.Uuid, input };
  }
  const fromTp = traceIdFromTraceparent(input);
  if (fromTp) return { ok: true, traceId: fromTp, rule: IdRule.Traceparent, input };

  const derived = derive(input);
  if (allZero(derived)) return reject(IdRejection.ZeroResult);
  return { ok: true, traceId: derived as TraceId, rule: IdRule.Derived, input };
}
