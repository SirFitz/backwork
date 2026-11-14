// Weekly digest delivery outcomes (BAC-77). Pure. Each destination (a channel, or one owner's or
// admin's email) gets "ok" or the reason it failed; a failed run stores them as JSON in
// `digest_runs.error`, so a retry sends only to the destinations that failed and nobody gets the
// week twice.

/** The answer that means a destination took the digest. */
export const DELIVERY_OK = "ok";
/** What a destination answered when it was skipped on purpose (not retried). */
export const DeliverySkip = { Disabled: "skipped: channel disabled", Missing: "skipped: channel not found" } as const;
export type DeliverySkip = (typeof DeliverySkip)[keyof typeof DeliverySkip];
/** The run's error when the system mailer has neither SES nor SMTP configured. */
export const MAILER_NOT_CONFIGURED = "mailer not configured";
/** The error of a run with no destination at all. */
export const NO_DESTINATIONS = "no destinations";

/** Destination kinds, the prefix of a destination key. */
export const DestinationKind = { Channel: "channel", Email: "email" } as const;
export type DestinationKind = (typeof DestinationKind)[keyof typeof DestinationKind];

/** By destination key ("channel:<id>", "email:<user id>"). */
export type Outcomes = Record<string, string>;

export function destinationKey(kind: DestinationKind, id: string): string {
  return `${kind}:${id}`;
}

/** A destination is done (never sent again this week) when it took the digest or was skipped. */
export function isSettled(outcome: string | undefined): boolean {
  return outcome === DELIVERY_OK || outcome === DeliverySkip.Disabled || outcome === DeliverySkip.Missing;
}

/** True when every destination is done. An empty set is not delivered. */
export function allSettled(o: Outcomes): boolean {
  const values = Object.values(o);
  return values.length > 0 && values.every((v) => isSettled(v));
}

/** Outcomes stored in a run's error text; anything else (a plain message) reads as none. */
export function parseOutcomes(text: string | null): Outcomes {
  if (!text) return {};
  try {
    const v: unknown = JSON.parse(text);
    if (typeof v !== "object" || v === null || Array.isArray(v)) return {};
    const out: Outcomes = {};
    for (const [k, val] of Object.entries(v)) if (typeof val === "string") out[k] = val;
    return out;
  } catch {
    return {};
  }
}

/** One line for the settings card: "Sent to Ops webhook; Slack failed: HTTP 500". */
export function outcomeLine(o: Outcomes, nameOf: (key: string) => string): string {
  const parts = Object.entries(o).map(([k, v]) => (v === DELIVERY_OK ? `sent to ${nameOf(k)}` : `${nameOf(k)} ${v.startsWith("skipped") ? v : `failed: ${v}`}`));
  const text = parts.join("; ");
  return text ? text[0].toUpperCase() + text.slice(1) : "";
}
