/**
 * Inkress embedded checkout: host-side client, protocol v1 (INK-1765).
 * Standard: docs/embedded-checkout/STANDARD.md in commerce-web.
 *
 * Vendor this file and `protocol.ts` verbatim into the host app (same folder). No dependencies, no
 * framework: it makes the iframe, sizes it to the frame's content, checks every message, and turns
 * them into typed events. A React (or other) wrapper is a few lines on top.
 *
 *   const handle = mountCheckout({
 *     container: el,
 *     url: embedUrl,               // from YOUR server, which minted the Inkress checkout with its key
 *     appearance: { theme: "dark", colors: { accent: "#e5484d" } },
 *     onEvent(e) { if (e.type === "succeeded") confirmOnYourServer(); },
 *   });
 *   handle.destroy();
 *
 * `succeeded` is never proof of payment: ask your server to read the order back from Inkress.
 */
import {
  APPEARANCE_PARAM,
  encodeAppearance,
  envelope,
  isFrameMessage,
  type Appearance,
  type FrameMessage,
  type HostMessage,
} from "./protocol";

/** Events the client adds on top of the frame's own messages. */
export type ClientEvent =
  /** The frame did not say `ready` in time: framing is blocked, or the network is down. Offer the popup. */
  | { type: "timeout" }
  /** The popup fallback opened, or was closed by the payer (paid or not: confirm server-side). */
  | { type: "popup"; open: boolean };

export type CheckoutEvent = FrameMessage | ClientEvent;

export interface MountOptions {
  container: HTMLElement;
  /** The frame URL your server built: `<inkress web>/payments/link/<uid>/embed`. */
  url: string;
  appearance?: Appearance;
  onEvent: (event: CheckoutEvent) => void;
  /** Accessible name of the frame. */
  title?: string;
  /** Height before the frame reports its own. */
  initialHeight?: number;
  /** How long to wait for `ready` before emitting `timeout`. */
  readyTimeoutMs?: number;
}

export interface CheckoutHandle {
  /** Re-theme the frame without reloading it (e.g. the host switched to dark mode). */
  setAppearance(appearance: Appearance): void;
  /** Open the same checkout as a full page in a popup (fallback when framing fails). */
  openPopup(): Window | null;
  destroy(): void;
}

/** The hosted (full-page) checkout for the same order: the popup fallback. */
export function popupUrlFor(embedUrl: string): string {
  const u = new URL(embedUrl);
  u.pathname = u.pathname.replace(/\/embed\/?$/, "/card");
  u.search = "";
  return u.toString();
}

export function frameSrc(url: string, appearance: Appearance | undefined): string {
  const u = new URL(url);
  if (appearance) u.searchParams.set(APPEARANCE_PARAM, encodeAppearance(appearance));
  return u.toString();
}

export function mountCheckout(options: MountOptions): CheckoutHandle {
  const { container, onEvent } = options;
  const frameOrigin = new URL(options.url).origin;
  const iframe = document.createElement("iframe");
  iframe.src = frameSrc(options.url, options.appearance);
  iframe.title = options.title ?? "Secure checkout by Inkress";
  // payment: Apple/Google Pay later; the card field itself needs nothing else.
  iframe.setAttribute("allow", "payment");
  iframe.style.cssText = [
    "display:block",
    "width:100%",
    "border:0",
    `height:${options.initialHeight ?? 420}px`,
    "background:transparent",
    "color-scheme:normal",
    "transition:height .18s ease",
    "overflow:hidden",
  ].join(";");
  if (options.appearance?.theme) iframe.style.colorScheme = options.appearance.theme;

  let ready = false;
  let popup: Window | null = null;
  let popupTimer: ReturnType<typeof setInterval> | null = null;

  const emit = (event: CheckoutEvent) => {
    try {
      onEvent(event);
    } catch (error) {
      console.error(error);
    }
  };

  const setHeight = (h: number) => {
    if (Number.isFinite(h) && h > 0) iframe.style.height = `${Math.ceil(Math.min(h, 4000))}px`;
  };

  const onMessage = (event: MessageEvent) => {
    if (event.origin !== frameOrigin || event.source !== iframe.contentWindow) return;
    const message: unknown = event.data;
    if (!isFrameMessage(message)) return;
    if (message.type === "ready") {
      ready = true;
      setHeight(message.height);
    } else if (message.type === "resize") {
      setHeight(message.height);
    }
    emit(message);
  };

  const send = (message: HostMessage) => iframe.contentWindow?.postMessage(message, frameOrigin);

  window.addEventListener("message", onMessage);
  container.replaceChildren(iframe);

  const timeout = setTimeout(() => {
    if (!ready) emit({ type: "timeout" });
  }, options.readyTimeoutMs ?? 12_000);

  const stopPopupWatch = () => {
    if (popupTimer) clearInterval(popupTimer);
    popupTimer = null;
  };

  return {
    setAppearance(appearance) {
      if (appearance.theme) iframe.style.colorScheme = appearance.theme;
      send({ ...envelope(), type: "appearance", appearance });
    },
    openPopup() {
      const w = 480;
      const h = 720;
      const left = Math.max(0, (window.screenX ?? 0) + (window.outerWidth - w) / 2);
      const top = Math.max(0, (window.screenY ?? 0) + (window.outerHeight - h) / 2);
      popup = window.open(popupUrlFor(options.url), "inkress-checkout", `popup,width=${w},height=${h},left=${left},top=${top}`);
      if (!popup) return null;
      emit({ type: "popup", open: true });
      stopPopupWatch();
      popupTimer = setInterval(() => {
        if (popup && popup.closed) {
          stopPopupWatch();
          popup = null;
          emit({ type: "popup", open: false });
        }
      }, 500);
      return popup;
    },
    destroy() {
      clearTimeout(timeout);
      stopPopupWatch();
      window.removeEventListener("message", onMessage);
      iframe.remove();
    },
  };
}
