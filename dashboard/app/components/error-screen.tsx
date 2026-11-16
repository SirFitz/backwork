import { useEffect, useState } from "react";
import { isRouteErrorResponse, useRouteError } from "@remix-run/react";
import { Link } from "~/components/env-link";
import { ErrorKind, describeError, type ErrorCopy } from "~/lib/error-copy";

const RECOVERY_POLL_MS = 6000;
/** A reload that lands on this screen again must not loop: at most this many automatic reloads per window. */
const MAX_AUTO_RELOADS = 3;
const RELOAD_WINDOW_MS = 120_000;
const RELOAD_LOG_KEY = "bw.errorReloads";

function mayAutoReload(): boolean {
  try {
    const now = Date.now();
    const recent = (JSON.parse(sessionStorage.getItem(RELOAD_LOG_KEY) ?? "[]") as number[]).filter((t) => now - t < RELOAD_WINDOW_MS);
    if (recent.length >= MAX_AUTO_RELOADS) return false;
    sessionStorage.setItem(RELOAD_LOG_KEY, JSON.stringify([...recent, now]));
    return true;
  } catch {
    return true;
  }
}

/** Reads whatever the router caught and returns customer-facing copy. */
export function useErrorCopy(): ErrorCopy {
  const error = useRouteError();
  // navigator is browser-only; the server render assumes online and the client corrects it.
  const [online, setOnline] = useState(true);
  useEffect(() => {
    setOnline(navigator.onLine);
    const up = () => setOnline(true);
    const down = () => setOnline(false);
    window.addEventListener("online", up);
    window.addEventListener("offline", down);
    return () => {
      window.removeEventListener("online", up);
      window.removeEventListener("offline", down);
    };
  }, []);
  if (isRouteErrorResponse(error)) return describeError({ status: error.status, message: typeof error.data === "string" ? error.data : error.statusText, online });
  return describeError({ message: error instanceof Error ? error.message : undefined, online });
}

/**
 * While the server is unreachable, ask the health endpoint every few seconds and
 * reload the moment it answers, so a deploy or a dropped connection heals without a click.
 */
function useAutoRecover(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return;
    let stopped = false;
    const probe = async (): Promise<void> => {
      try {
        const res = await fetch("/healthz", { cache: "no-store" });
        if (res.ok && !stopped && mayAutoReload()) window.location.reload();
      } catch {
        /* still down: keep waiting */
      }
    };
    const id = window.setInterval(probe, RECOVERY_POLL_MS);
    window.addEventListener("online", probe);
    return () => {
      stopped = true;
      window.clearInterval(id);
      window.removeEventListener("online", probe);
    };
  }, [enabled]);
}

const BTN_PRIMARY = "inline-flex h-9 items-center rounded-lg bg-brand px-4 text-[13px] font-medium text-brand-fg hover:opacity-90";
const BTN_QUIET = "inline-flex h-9 items-center rounded-lg border border-border-strong px-4 text-[13px] font-medium text-fg hover:bg-surface-2";

export function ErrorScreen({ copy }: { copy: ErrorCopy }) {
  useAutoRecover(copy.autoRecover);
  const live = copy.autoRecover;
  return (
    <main className="mx-auto flex min-h-[60vh] max-w-md flex-col items-center justify-center px-6 py-16 text-center" role="alert">
      <span className="grid h-10 w-10 place-items-center rounded-xl bg-brand font-mono text-lg font-bold text-brand-fg">b</span>
      <h1 className="mt-5 text-[20px] font-semibold tracking-tight">{copy.title}</h1>
      <p className="mt-2 text-[14px] leading-relaxed text-muted">{copy.body}</p>
      {live ? (
        <p className="mt-3 flex items-center gap-2 text-[12px] text-faint" aria-live="polite">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-warn" />
          Reconnecting
        </p>
      ) : null}
      <div className="mt-6 flex flex-wrap items-center justify-center gap-2">
        {copy.kind === ErrorKind.SignedOut ? (
          <a href="/login" className={BTN_PRIMARY}>
            Sign in
          </a>
        ) : copy.canRetry ? (
          <button type="button" onClick={() => window.location.reload()} className={BTN_PRIMARY}>
            Try again
          </button>
        ) : null}
        {copy.kind !== ErrorKind.SignedOut ? (
          <Link to="/" className={copy.canRetry ? BTN_QUIET : BTN_PRIMARY}>
            Go to Overview
          </Link>
        ) : null}
      </div>
      {copy.detail ? (
        <details className="mt-8 text-[12px] text-faint">
          <summary className="cursor-pointer select-none hover:text-muted">Technical details</summary>
          <p className="mt-2 break-words font-mono">{copy.detail}</p>
        </details>
      ) : null}
    </main>
  );
}
