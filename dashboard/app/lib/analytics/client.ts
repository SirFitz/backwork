// Browser helper. Events only leave when the current URL is one of our own bare screens, because f.js
// stamps every event with location.href.
import type { ClientEvent, ClientEventProps } from "./events";
import { isTrackableLocation } from "./paths";

declare global {
  interface Window {
    flat?: ((...args: unknown[]) => void) & { q?: unknown[] };
  }
}

export function installStub(): void {
  if (window.flat) return;
  const queue: unknown[] = [];
  window.flat = Object.assign(
    (...args: unknown[]): void => {
      queue.push(args);
    },
    { q: queue },
  );
}

export function track<E extends ClientEvent>(name: E, props: ClientEventProps[E]): void {
  try {
    if (!window.flat || !isTrackableLocation(window.location)) return;
    window.flat("event", name, props);
  } catch {
    // analytics must never break the app
  }
}

export function pageview(): void {
  try {
    if (window.flat && isTrackableLocation(window.location)) window.flat("pageview");
  } catch {
    // ignore
  }
}
