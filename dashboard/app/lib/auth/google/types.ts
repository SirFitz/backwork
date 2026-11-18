/** Shared, browser-safe vocabulary for "Continue with Google" (BAC-101). No secrets, no server imports. */

export const GoogleIntent = { SignIn: "signin", SignUp: "signup" } as const;
export type GoogleIntent = (typeof GoogleIntent)[keyof typeof GoogleIntent];

export function parseGoogleIntent(value: unknown): GoogleIntent {
  return value === GoogleIntent.SignUp ? GoogleIntent.SignUp : GoogleIntent.SignIn;
}

/** Every way the Google flow can end badly. The page shows one plain sentence per code (GOOGLE_ERROR_COPY). */
export const GoogleErrorCode = {
  Cancelled: "cancelled",
  StateMismatch: "state_mismatch",
  ExchangeFailed: "exchange_failed",
  TokenInvalid: "token_invalid",
  EmailUnverified: "email_unverified",
  NoAccount: "no_account",
  AccountConflict: "account_conflict",
  RateLimited: "rate_limited",
} as const;
export type GoogleErrorCode = (typeof GoogleErrorCode)[keyof typeof GoogleErrorCode];

export const GOOGLE_ERROR_COPY: Record<GoogleErrorCode, string> = {
  [GoogleErrorCode.Cancelled]: "Google sign-in was cancelled. You can try again or use your email.",
  [GoogleErrorCode.StateMismatch]: "That Google sign-in expired. Please try again.",
  [GoogleErrorCode.ExchangeFailed]: "We couldn't complete sign-in with Google. Please try again.",
  [GoogleErrorCode.TokenInvalid]: "We couldn't complete sign-in with Google. Please try again.",
  [GoogleErrorCode.EmailUnverified]: "Google hasn't verified that email address, so we can't use it. Verify it with Google, or use your email and password.",
  [GoogleErrorCode.NoAccount]: "There is no backwork account for that Google address yet. Create one instead.",
  [GoogleErrorCode.AccountConflict]: "That email belongs to a backwork account linked to a different Google account. Sign in with your email and password.",
  [GoogleErrorCode.RateLimited]: "Too many attempts. Please wait a few minutes and try again.",
};

export function isGoogleErrorCode(value: unknown): value is GoogleErrorCode {
  return typeof value === "string" && (Object.values(GoogleErrorCode) as string[]).includes(value);
}

/** The plain sentence for a `?google=<code>` query value, or null when it is absent or unknown. */
export function googleErrorMessage(value: string | null): string | null {
  return isGoogleErrorCode(value) ? GOOGLE_ERROR_COPY[value] : null;
}

export const GOOGLE_START_PATH = "/auth/google/start";
export const GOOGLE_CALLBACK_PATH = "/auth/google/callback";

/** The link the "Continue with Google" button points at. */
export function googleStartHref(opts: { intent: GoogleIntent; next?: string | null; plan?: string | null }): string {
  const q = new URLSearchParams({ intent: opts.intent });
  if (opts.next && opts.next !== "/") q.set("next", opts.next);
  if (opts.plan) q.set("plan", opts.plan);
  return `${GOOGLE_START_PATH}?${q.toString()}`;
}

/** What Google proved about the person, after every token check has passed. */
export interface GoogleIdentity {
  sub: string;
  email: string;
  name: string;
}

/** Thrown for any failed check; `code` picks the message the person sees. */
export class GoogleAuthError extends Error {
  constructor(readonly code: GoogleErrorCode, detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "GoogleAuthError";
  }
}
