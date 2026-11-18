import { createCookie } from "@remix-run/node";
import { signingSecret } from "../session.server";
import { GoogleIntent, type GoogleIntent as Intent } from "./types";

/** What the start route remembers across the trip to Google. Signed, so it cannot be edited. */
export interface GoogleStatePayload {
  state: string;
  nonce: string;
  verifier: string;
  intent: Intent;
  next: string;
  plan: string | null;
}

const TEN_MINUTES = 10 * 60;

const cookie = createCookie("backwork_google", {
  httpOnly: true,
  sameSite: "lax",
  path: "/auth/google",
  secure: process.env.NODE_ENV === "production",
  maxAge: TEN_MINUTES,
  secrets: [signingSecret],
});

export function commitStateCookie(payload: GoogleStatePayload): Promise<string> {
  return cookie.serialize(payload);
}

/** An expired-immediately cookie, sent with every callback response so a state is used once. */
export function clearStateCookie(): Promise<string> {
  return cookie.serialize("", { maxAge: 0, expires: new Date(0) });
}

function isPayload(v: unknown): v is GoogleStatePayload {
  if (!v || typeof v !== "object") return false;
  const p = v as Record<string, unknown>;
  return (
    typeof p.state === "string" && typeof p.nonce === "string" && typeof p.verifier === "string" &&
    (p.intent === GoogleIntent.SignIn || p.intent === GoogleIntent.SignUp) &&
    typeof p.next === "string" && (p.plan === null || typeof p.plan === "string")
  );
}

export async function readStateCookie(request: Request): Promise<GoogleStatePayload | null> {
  const parsed: unknown = await cookie.parse(request.headers.get("Cookie"));
  return isPayload(parsed) ? parsed : null;
}
