/** Remembers whether the header's Live/Pause toggle is paused, per browser (BAC-56). */

export const LIVE_PAUSED_KEY = "backwork.live.paused";

/** The slice of the Storage interface used here, so tests can pass a plain object. */
export interface PrefStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** Storage can be missing or throw (private window, blocked site data): fall back to live. */
function browserStorage(): PrefStorage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function readLivePaused(storage: PrefStorage | null = browserStorage()): boolean {
  try {
    return storage?.getItem(LIVE_PAUSED_KEY) === "1";
  } catch {
    return false;
  }
}

export function writeLivePaused(paused: boolean, storage: PrefStorage | null = browserStorage()): void {
  try {
    storage?.setItem(LIVE_PAUSED_KEY, paused ? "1" : "0");
  } catch {
    // Not persisted; the toggle still works for this page view.
  }
}
