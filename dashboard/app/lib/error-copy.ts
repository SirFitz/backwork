/**
 * Turns anything a route can throw, or any raw failure string from a panel, into
 * words a customer can act on. Raw messages ("Failed to fetch", a Postgres error,
 * a stack line) never reach a heading or body; they only go in the collapsed
 * "Technical details" line for support.
 */

export enum ErrorKind {
  /** The browser has no connection at all. */
  Offline = "offline",
  /** A request never got an answer: server restarting, deploy swapping the build, network drop. */
  Unreachable = "unreachable",
  NotFound = "not_found",
  SignedOut = "signed_out",
  Forbidden = "forbidden",
  Server = "server",
  Unknown = "unknown",
}

export interface ErrorCopy {
  kind: ErrorKind;
  title: string;
  body: string;
  /** Reloading can plausibly fix it. */
  canRetry: boolean;
  /** The page should retry by itself once the server answers again. */
  autoRecover: boolean;
  /** Short, trimmed, for the collapsed details line. */
  detail: string;
}

export interface ErrorInput {
  /** HTTP status when the failure was a response. */
  status?: number;
  /** Raw message when the failure was a thrown error or a string. */
  message?: string;
  /** `navigator.onLine` when known (browser only). */
  online?: boolean;
}

const NETWORK_PATTERN =
  /failed to fetch|load failed|networkerror|network request failed|fetch failed|err_network|err_internet|econnrefused|econnreset|etimedout|enotfound|socket hang up|timed? ?out|aborted|connection (terminated|refused|reset|closed)|too many clients|pool/i;

const MAX_DETAIL = 160;

function trim(text: string): string {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > MAX_DETAIL ? `${one.slice(0, MAX_DETAIL - 1)}…` : one;
}

export function isNetworkFailure(message: string | undefined): boolean {
  return Boolean(message && NETWORK_PATTERN.test(message));
}

export function describeError({ status, message, online }: ErrorInput): ErrorCopy {
  const detail = trim([status ? String(status) : "", message ?? ""].filter(Boolean).join(" "));

  if (online === false) {
    return {
      kind: ErrorKind.Offline,
      title: "You're offline",
      body: "Check your internet connection. This page reconnects by itself as soon as you're back online.",
      canRetry: true,
      autoRecover: true,
      detail,
    };
  }
  if (status === 401) {
    return {
      kind: ErrorKind.SignedOut,
      title: "Your session has ended",
      body: "Sign in again to carry on where you left off.",
      canRetry: false,
      autoRecover: false,
      detail,
    };
  }
  if (status === 403) {
    return {
      kind: ErrorKind.Forbidden,
      title: "You don't have access to this",
      body: "Your role in this organisation can't open this page. Ask an owner for access, or switch to another organisation.",
      canRetry: false,
      autoRecover: false,
      detail,
    };
  }
  if (status === 404) {
    return {
      kind: ErrorKind.NotFound,
      title: "We can't find that page",
      body: "The address may be mistyped, or the page was moved or removed.",
      canRetry: false,
      autoRecover: false,
      detail,
    };
  }
  if ((status === 502 || status === 503 || status === 504) || (!status && isNetworkFailure(message))) {
    return {
      kind: ErrorKind.Unreachable,
      title: "We can't reach backwork.dev right now",
      body: "The connection dropped, or we're in the middle of an update. Your data is safe. This page reconnects by itself in a few seconds.",
      canRetry: true,
      autoRecover: true,
      detail,
    };
  }
  if (status && status >= 500) {
    return {
      kind: ErrorKind.Server,
      title: "Something went wrong on our side",
      body: "We couldn't finish loading this page. Try again in a moment. Your data is safe.",
      canRetry: true,
      autoRecover: false,
      detail,
    };
  }
  return {
    kind: ErrorKind.Unknown,
    title: "This page couldn't be shown",
    body: "Something unexpected happened while loading it. Try again, and if it keeps happening, tell support what you were doing.",
    canRetry: true,
    autoRecover: false,
    detail,
  };
}

/**
 * One calm line for a panel that failed inside a page that is otherwise fine.
 * Takes the raw failure string a loader recorded and never echoes it.
 */
export function describePanelError(raw: string | null | undefined): string {
  if (isNetworkFailure(raw ?? undefined)) return "This section couldn't load in time. Reload to try again.";
  return "This section couldn't load. Reload to try again.";
}
