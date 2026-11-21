// The Inkress embedded checkout in a React page (BAC-102). A thin wrapper over the vendored
// client (lib/billing/checkout-embed, copied verbatim from commerce-web INK-1765): it mounts the
// frame, passes backwork's own colours, and re-themes the frame when the app switches light/dark.
import { useEffect, useRef } from "react";
import { mountCheckout, type CheckoutEvent, type CheckoutHandle } from "~/lib/billing/checkout-embed/client";
import { AppearanceFont, type Appearance } from "~/lib/billing/checkout-embed/protocol";

/** backwork's tokens are `L C H` triplets on :root (tailwind.css); the frame takes `oklch(L C H)`. */
function token(styles: CSSStyleDeclaration, name: string): string | undefined {
  const raw = styles.getPropertyValue(name).trim();
  return /^[\d.]+\s+[\d.]+\s+[\d.]+$/.test(raw) ? `oklch(${raw})` : undefined;
}

/** The frame sits on a Card (`--surface`); its inputs and panels use the page background. */
export function backworkAppearance(): Appearance {
  const root = document.documentElement;
  const s = getComputedStyle(root);
  return {
    theme: root.classList.contains("dark") ? "dark" : "light",
    colors: {
      background: token(s, "--surface"),
      surface: token(s, "--bg"),
      text: token(s, "--fg"),
      muted: token(s, "--muted"),
      border: token(s, "--border"),
      accent: token(s, "--brand"),
      accentText: token(s, "--brand-fg"),
      danger: token(s, "--err"),
    },
    radius: 8,
    font: AppearanceFont.Inter,
  };
}

export interface InkressCheckoutHandle {
  openPopup(): void;
}

export function InkressCheckout({
  url,
  onEvent,
  handleRef,
}: {
  url: string;
  onEvent: (event: CheckoutEvent) => void;
  handleRef?: { current: InkressCheckoutHandle | null };
}) {
  const container = useRef<HTMLDivElement>(null);
  const events = useRef(onEvent);
  events.current = onEvent;

  useEffect(() => {
    if (!container.current) return;
    const handle: CheckoutHandle = mountCheckout({
      container: container.current,
      url,
      appearance: backworkAppearance(),
      title: "Secure checkout by Inkress",
      initialHeight: 380,
      onEvent: (e) => events.current(e),
    });
    if (handleRef) handleRef.current = { openPopup: () => void handle.openPopup() };
    // The theme toggle flips the `dark` class on <html>: follow it without reloading the frame.
    const observer = new MutationObserver(() => handle.setAppearance(backworkAppearance()));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => {
      observer.disconnect();
      if (handleRef) handleRef.current = null;
      handle.destroy();
    };
  }, [url, handleRef]);

  return <div ref={container} className="w-full" />;
}
