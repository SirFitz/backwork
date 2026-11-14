// Pin / Unpin on the request view (BAC-78). "Pin" opens a small form with one optional note in the
// browser's top layer (`popover="manual"`, as AuthMenu and FindRequest in root.tsx), positioned
// against the window under the button and kept on screen, so the header never clips it (UI_ISSUES 2).
import { useFetcher } from "@remix-run/react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Pin, PinOff } from "lucide-react";
import { PIN_NOTE_MAX_CHARS, PinIntent, type PinActionData } from "~/lib/pins";

/** The `popover="manual"` attribute, which React 18's types do not know. */
const POPOVER_MANUAL: Record<string, string> = { popover: "manual" };
/** Width of the note form, px. */
const PIN_POPOVER_WIDTH_PX = 288;
/** Gap between the form and the window edge, px. */
const PIN_POPOVER_EDGE_PX = 8;

const BUTTON = "inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-border bg-surface px-2.5 text-2xs font-medium text-muted hover:bg-surface-2 hover:text-fg disabled:opacity-60";

export function PinButton({ traceId, pinned }: { traceId: string; pinned: boolean }) {
  const fetcher = useFetcher<PinActionData>();
  const action = `/requests/${traceId}`;
  const busy = fetcher.state !== "idle";
  const anchorRef = useRef<HTMLDivElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const noteId = useId();

  const place = useCallback(() => {
    const pop = popRef.current;
    const box = anchorRef.current?.getBoundingClientRect();
    if (!pop || !box) return;
    const width = Math.min(PIN_POPOVER_WIDTH_PX, window.innerWidth - 2 * PIN_POPOVER_EDGE_PX);
    const left = Math.max(PIN_POPOVER_EDGE_PX, Math.min(box.right - width, window.innerWidth - width - PIN_POPOVER_EDGE_PX));
    Object.assign(pop.style, { top: `${box.bottom + 6}px`, left: `${left}px`, width: `${width}px` });
  }, []);

  const show = useCallback(() => {
    const pop = popRef.current;
    if (!pop) return;
    place();
    if (!pop.matches(":popover-open")) pop.showPopover();
    setOpen(true);
    requestAnimationFrame(() => pop.querySelector("input")?.focus());
  }, [place]);

  const hide = useCallback(() => {
    const pop = popRef.current;
    if (pop?.matches(":popover-open")) pop.hidePopover();
    setOpen(false);
  }, []);

  // Escape and a click outside close it; it follows its button on resize and scroll.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") hide(); };
    const onDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (popRef.current?.contains(target) || anchorRef.current?.contains(target)) return;
      hide();
    };
    const onMove = () => place();
    window.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onDown);
    window.addEventListener("resize", onMove);
    window.addEventListener("scroll", onMove, true);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onDown);
      window.removeEventListener("resize", onMove);
      window.removeEventListener("scroll", onMove, true);
    };
  }, [open, hide, place]);

  // A pin that went through closes the form; a refusal stays open with its reason.
  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data?.ok) hide();
  }, [fetcher.state, fetcher.data, hide]);

  const error = fetcher.data && !fetcher.data.ok ? fetcher.data.error : null;

  if (pinned) {
    return (
      <fetcher.Form method="post" action={action} className="shrink-0">
        <input type="hidden" name="intent" value={PinIntent.Unpin} />
        <button type="submit" disabled={busy} className={BUTTON} title="Remove the saved copy of this request">
          <PinOff className="h-3.5 w-3.5" /> {busy ? "Unpinning…" : "Unpin"}
        </button>
        {error ? <span className="sr-only" role="status">{error}</span> : null}
      </fetcher.Form>
    );
  }

  return (
    <div ref={anchorRef} className="shrink-0">
      <button type="button" onClick={() => (open ? hide() : show())} aria-expanded={open} aria-haspopup="dialog" className={BUTTON} title="Keep a copy of this request after its records expire">
        <Pin className="h-3.5 w-3.5" /> Pin
      </button>
      <div
        ref={popRef}
        data-pin-popover
        role="dialog"
        aria-label="Pin this request"
        // Rendered on the server too, so the closed form is hidden before hydration.
        {...POPOVER_MANUAL}
        className="fixed m-0 rounded-lg border border-border bg-surface p-3 text-fg shadow-lg"
        style={{ inset: "auto" }}
      >
        <fetcher.Form method="post" action={action} className="space-y-2">
          <input type="hidden" name="intent" value={PinIntent.Pin} />
          <label htmlFor={noteId} className="block text-2xs text-muted">Note (optional)</label>
          <div className="flex gap-2">
            <input
              id={noteId}
              name="note"
              maxLength={PIN_NOTE_MAX_CHARS}
              placeholder="Why keep it"
              className="h-8 min-w-0 flex-1 rounded-md border border-border bg-bg px-2.5 text-[13px] outline-none placeholder:text-faint focus:border-brand/40"
            />
            <button type="submit" disabled={busy} className="inline-flex h-8 shrink-0 items-center rounded-md bg-brand px-3 text-[12.5px] font-medium text-brand-fg disabled:opacity-60">
              {busy ? "Keeping…" : "Keep"}
            </button>
          </div>
          {error ? <p className="m-0 text-2xs text-warn" role="alert">{error}</p> : null}
        </fetcher.Form>
      </div>
    </div>
  );
}
