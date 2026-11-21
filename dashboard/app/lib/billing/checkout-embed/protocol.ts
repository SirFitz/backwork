/**
 * Inkress embedded checkout protocol, version 1 (INK-1765). Standard: docs/embedded-checkout/STANDARD.md.
 *
 * Shared, dependency-free types for both sides of the frame:
 *   - the checkout frame (commerce-web `/payments/link/<uid>/embed`), and
 *   - the host app's page (it vendors this file and `client.ts` verbatim).
 *
 * Every message carries `source` and `v`, so neither side reacts to some other script's messages.
 * Each side also checks `event.origin` (the frame posts only to the origin its order was bound to;
 * the host listens only to the Inkress origin it framed) and `event.source`.
 *
 * Nothing in a message is proof of payment. A host treats `succeeded` as "ask your server to look
 * again at Inkress", never as paid.
 */

export const PROTOCOL_SOURCE = "inkress-checkout";
export const PROTOCOL_VERSION = 1;

/** What the frame is collecting. */
export const CheckoutKind = {
  /** A payment (one-off or the first payment of a subscription). */
  Payment: "payment",
  /** A card check that replaces a subscription's card on file (small hold, released). */
  CardUpdate: "card_update",
} as const;
export type CheckoutKind = (typeof CheckoutKind)[keyof typeof CheckoutKind];

/** Where the payer is inside the frame. Hosts use it for copy and to scroll the frame into view. */
export const CheckoutStep = {
  /** Risk check before the card form (usually invisible, sometimes a Turnstile challenge). */
  Risk: "risk",
  Card: "card",
  /** Card submitted, waiting for the processor. */
  Processing: "processing",
  /** The bank's 3-D Secure page is showing (inline, or in a popup when `popup` is true). */
  ThreeDS: "3ds",
  /** Inkress has settled the payment; the frame is showing its done state. */
  Done: "done",
} as const;
export type CheckoutStep = (typeof CheckoutStep)[keyof typeof CheckoutStep];

/** Why the frame cannot (or could not) take the payment. */
export const FailureCode = {
  /** The card was declined or failed 3-D Secure. The form is still there: the payer can retry. */
  Declined: "declined",
  /** The payer must fix a field (the form shows which). */
  Invalid: "invalid",
  /** Something went wrong talking to Inkress or the processor. The payer can retry. */
  Error: "error",
  /** The checkout is already paid (a second tab, or a reload after paying). Confirm server-side. */
  AlreadyPaid: "already_paid",
  /** The checkout is closed, expired, cancelled or unknown. Mint a new one. */
  Unavailable: "unavailable",
  /** This origin is not registered for this merchant, or the checkout was bound to another origin. */
  OriginNotAllowed: "origin_not_allowed",
  /** The risk check refused this payer. No reason is given on purpose. */
  Blocked: "blocked",
} as const;
export type FailureCode = (typeof FailureCode)[keyof typeof FailureCode];

/** Failure codes after which the frame keeps the form up for another attempt. */
export const RETRYABLE_FAILURES: readonly FailureCode[] = [FailureCode.Declined, FailureCode.Invalid, FailureCode.Error];

/** Host theming. All optional; anything invalid is ignored by the frame. */
export interface Appearance {
  theme?: "light" | "dark";
  /** Colours as `#rrggbb` or `oklch(L C H)` (numbers only). */
  colors?: {
    /** Page behind the form. Use the host surface the frame sits on; default transparent. */
    background?: string;
    /** Inputs and panels. */
    surface?: string;
    text?: string;
    muted?: string;
    border?: string;
    /** Pay button and focus. */
    accent?: string;
    /** Text on the accent. */
    accentText?: string;
    danger?: string;
  };
  /** Corner radius in px, 0 to 24. */
  radius?: number;
  /** One of the frame's known font stacks. */
  font?: AppearanceFont;
}

export const AppearanceFont = {
  System: "system",
  Inter: "inter",
} as const;
export type AppearanceFont = (typeof AppearanceFont)[keyof typeof AppearanceFont];

interface Envelope {
  source: typeof PROTOCOL_SOURCE;
  v: typeof PROTOCOL_VERSION;
}

/** Frame → host. */
export type FrameMessage = Envelope &
  (
    | { type: "ready"; kind: CheckoutKind; height: number; amount: number | null; currency: string | null; test: boolean }
    | { type: "resize"; height: number }
    | { type: "step"; step: CheckoutStep; popup: boolean }
    | { type: "succeeded"; orderId: number | null; reference: string | null }
    | { type: "failed"; code: FailureCode; message: string; retryable: boolean }
  );

/** Host → frame. */
export type HostMessage = Envelope & { type: "appearance"; appearance: Appearance };

export type FrameMessageType = FrameMessage["type"];

function isEnvelope(value: unknown): value is Envelope & { type: unknown } {
  const v = value as { source?: unknown; v?: unknown } | null;
  return typeof v === "object" && v !== null && v.source === PROTOCOL_SOURCE && v.v === PROTOCOL_VERSION;
}

const FRAME_TYPES: readonly string[] = ["ready", "resize", "step", "succeeded", "failed"];

export function isFrameMessage(value: unknown): value is FrameMessage {
  return isEnvelope(value) && typeof value.type === "string" && FRAME_TYPES.includes(value.type);
}

export function isHostMessage(value: unknown): value is HostMessage {
  return isEnvelope(value) && value.type === "appearance";
}

export function envelope(): Envelope {
  return { source: PROTOCOL_SOURCE, v: PROTOCOL_VERSION };
}

/** The query parameter the host's appearance travels in on the frame URL (base64url JSON). */
export const APPEARANCE_PARAM = "appearance";

const HEX = /^#[0-9a-fA-F]{6}$/;
const OKLCH = /^oklch\(\s*(0|1|0?\.\d+|1\.0+|\d{1,3}(\.\d+)?%)\s+(0|0?\.\d+)\s+(\d{1,3}(\.\d+)?)\s*(\/\s*(0|1|0?\.\d+))?\s*\)$/;

/** A colour the frame will put into a CSS variable, or null. Only hex and numeric oklch pass. */
export function safeColor(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const v = value.trim();
  return HEX.test(v) || OKLCH.test(v) ? v : null;
}

/** Keep only well-formed appearance fields. Untrusted input (a URL or a message). */
export function sanitizeAppearance(raw: unknown): Appearance {
  if (typeof raw !== "object" || raw === null) return {};
  const r = raw as Record<string, unknown>;
  const out: Appearance = {};
  if (r.theme === "light" || r.theme === "dark") out.theme = r.theme;
  if (typeof r.radius === "number" && Number.isFinite(r.radius)) out.radius = Math.max(0, Math.min(24, Math.round(r.radius)));
  if (r.font === AppearanceFont.System || r.font === AppearanceFont.Inter) out.font = r.font;
  if (typeof r.colors === "object" && r.colors !== null) {
    const c = r.colors as Record<string, unknown>;
    const colors: NonNullable<Appearance["colors"]> = {};
    for (const key of ["background", "surface", "text", "muted", "border", "accent", "accentText", "danger"] as const) {
      const safe = safeColor(c[key]);
      if (safe) colors[key] = safe;
    }
    if (Object.keys(colors).length) out.colors = colors;
  }
  return out;
}

function toBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  bytes.forEach((b) => (bin += String.fromCharCode(b)));
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(text: string): string {
  const b64 = text.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64 + "===".slice((b64.length + 3) % 4));
  return new TextDecoder().decode(Uint8Array.from(bin, (ch) => ch.charCodeAt(0)));
}

export function encodeAppearance(appearance: Appearance): string {
  return toBase64Url(JSON.stringify(sanitizeAppearance(appearance)));
}

export function decodeAppearance(param: string | null | undefined): Appearance {
  if (!param || param.length > 2048) return {};
  try {
    return sanitizeAppearance(JSON.parse(fromBase64Url(param)));
  } catch {
    return {};
  }
}
