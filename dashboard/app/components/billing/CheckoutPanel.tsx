// The embedded Inkress checkout on the Billing page (BAC-102): the frame, then "look again at
// Inkress" through our own server before anything on the page changes. Standard: commerce-web
// docs/embedded-checkout/STANDARD.md (inkress-checkout/1).
import { useCallback, useEffect, useRef, useState } from "react";
import { useFetcher, useRevalidator } from "@remix-run/react";
import { ArrowLeft, Check, ExternalLink, Loader2, Lock } from "lucide-react";
import { Card, CardHead } from "~/components/ui";
import { InkressCheckout, type InkressCheckoutHandle } from "~/components/billing/InkressCheckout";
import { CheckoutPurpose, ConfirmState } from "~/lib/billing/types";
import { FailureCode, CheckoutStep } from "~/lib/billing/checkout-embed/protocol";
import type { CheckoutEvent } from "~/lib/billing/checkout-embed/client";
import { track } from "~/lib/analytics/client";
import { ClientEvent, CtaLocation } from "~/lib/analytics/events";

/** What the page shows next to the frame. */
export interface CheckoutSummary {
  title: string;
  /** e.g. "US$29.00 a month". */
  price: string | null;
  lines: string[];
}

export interface CheckoutPanelProps {
  purpose: CheckoutPurpose;
  embedUrl: string;
  fallbackUrl: string | null;
  summary: CheckoutSummary;
  /** Shown once Inkress confirms, e.g. "You're on Team." */
  doneText: string;
  onClose: () => void;
}

enum Phase {
  Paying = "paying",
  /** The frame did not load (framing blocked, offline): offer the secure window. */
  Blocked = "blocked",
  /** The payer is finishing in the popup. */
  Popup = "popup",
  Confirming = "confirming",
  Done = "done",
  /** Inkress has not confirmed yet after every retry; the webhook will settle it. */
  Slow = "slow",
  Failed = "failed",
}

/** Backoff for "look again", about 30 s in all: the subscription can land just after the payment. */
const CONFIRM_DELAYS_MS = [600, 1200, 2000, 3000, 4500, 6000, 6000, 7000];

interface ConfirmAnswer {
  confirm?: ConfirmState;
  error?: string;
}

export function CheckoutPanel({ purpose, embedUrl, fallbackUrl, summary, doneText, onClose }: CheckoutPanelProps) {
  const [phase, setPhase] = useState<Phase>(Phase.Paying);
  const [message, setMessage] = useState<string | null>(null);
  const [inkressStep, setInkressStep] = useState<CheckoutStep>(CheckoutStep.Card);
  const confirmer = useFetcher<ConfirmAnswer>();
  const revalidator = useRevalidator();
  const attempt = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const panel = useRef<HTMLDivElement>(null);
  const handle = useRef<InkressCheckoutHandle | null>(null);
  const intent = purpose === CheckoutPurpose.CardUpdate ? "confirm_card_update" : "confirm_checkout";

  const confirmNow = useCallback(() => {
    confirmer.submit({ intent }, { method: "post", action: "/billing" });
  }, [confirmer, intent]);

  const startConfirming = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    attempt.current = 0;
    setPhase(Phase.Confirming);
    confirmNow();
  }, [confirmNow]);

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  // Our server's answer after it read the order back from Inkress.
  useEffect(() => {
    if (confirmer.state !== "idle" || !confirmer.data || phase !== Phase.Confirming) return;
    const answer = confirmer.data;
    if (answer.confirm === ConfirmState.Done) {
      setPhase(Phase.Done);
      revalidator.revalidate();
      return;
    }
    if (answer.confirm === ConfirmState.Failed) {
      setPhase(Phase.Failed);
      setMessage("The payment did not go through. Nothing was charged. Try again with another card.");
      return;
    }
    if (answer.error) {
      setPhase(Phase.Failed);
      setMessage(answer.error);
      return;
    }
    const delay = CONFIRM_DELAYS_MS[attempt.current];
    if (delay === undefined) {
      setPhase(Phase.Slow);
      return;
    }
    attempt.current += 1;
    timer.current = setTimeout(confirmNow, delay);
    // Only a fresh answer moves this on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [confirmer.state, confirmer.data]);

  const onEvent = useCallback(
    (e: CheckoutEvent) => {
      switch (e.type) {
        case "step":
          setInkressStep(e.step);
          if (e.step === CheckoutStep.ThreeDS) panel.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
          break;
        case "succeeded":
          startConfirming();
          break;
        case "failed":
          track(ClientEvent.CheckoutFrameFailed, { code: e.code, retryable: e.retryable });
          if (e.code === FailureCode.AlreadyPaid) startConfirming();
          else if (!e.retryable) {
            setPhase(Phase.Failed);
            setMessage(e.code === FailureCode.Blocked ? "This payment could not be accepted. Contact support if you think this is wrong." : e.message);
          }
          break;
        case "timeout":
          setPhase((p) => (p === Phase.Paying ? Phase.Blocked : p));
          break;
        case "popup":
          if (e.open) setPhase(Phase.Popup);
          else startConfirming();
          break;
        default:
          break;
      }
    },
    [startConfirming],
  );

  const done = phase === Phase.Done;
  const showFrame = phase === Phase.Paying || phase === Phase.Confirming || phase === Phase.Popup || phase === Phase.Blocked;
  const title = purpose === CheckoutPurpose.CardUpdate ? "Update card" : summary.title;

  return (
    <Card>
      <CardHead
        title={title}
        sub={purpose === CheckoutPurpose.CardUpdate ? "the new card is used from your next renewal" : "pay without leaving backwork"}
        right={
          !done ? (
            <button type="button" onClick={onClose} disabled={phase === Phase.Confirming} className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border bg-surface px-3 text-[13px] font-medium hover:bg-surface-2 disabled:opacity-60">
              <ArrowLeft className="h-3.5 w-3.5" />
              {purpose === CheckoutPurpose.CardUpdate ? "Keep current card" : "Back to plans"}
            </button>
          ) : null
        }
      />
      <div ref={panel} className="grid gap-6 px-4 py-4 md:grid-cols-[minmax(0,1fr)_minmax(0,440px)] md:gap-8">
        <aside className="space-y-3 text-[13px]">
          {summary.price ? <p className="text-[22px] font-semibold tracking-tight">{summary.price}</p> : null}
          <ul className="grid gap-1.5 text-muted">
            {summary.lines.map((l) => (
              <li key={l} className="flex gap-1.5"><Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-ok" />{l}</li>
            ))}
          </ul>
          <p className="flex items-center gap-1.5 text-[12px] text-faint"><Lock className="h-3 w-3" />Card details go to Inkress, backwork never sees them.</p>
        </aside>

        <div className="min-w-0" aria-live="polite">
          {done ? (
            <div className="grid justify-items-center gap-2 rounded-lg border border-border px-4 py-8 text-center">
              <span className="grid h-10 w-10 place-items-center rounded-full bg-ok/15 text-ok"><Check className="h-5 w-5" /></span>
              <p className="text-[14px] font-medium">{doneText}</p>
              <p className="text-[12.5px] text-muted">Confirmed with Inkress.</p>
              <button type="button" onClick={onClose} className="mt-2 inline-flex h-8 items-center rounded-lg bg-brand px-3 text-[13px] font-medium text-brand-fg hover:opacity-90">Done</button>
            </div>
          ) : phase === Phase.Failed ? (
            <div className="grid gap-3 rounded-lg border border-border px-4 py-6 text-[13px]">
              <p role="alert" className="text-err">{message}</p>
              <button type="button" onClick={onClose} className="justify-self-start rounded-lg border border-border bg-surface px-3 py-1.5 font-medium hover:bg-surface-2">Back</button>
            </div>
          ) : phase === Phase.Slow ? (
            <div className="grid gap-2 rounded-lg border border-border px-4 py-6 text-[13px]">
              <p className="font-medium">Inkress has not confirmed it yet.</p>
              <p className="text-muted">If you paid, this page updates by itself within a few minutes. You will not be charged twice.</p>
              <button type="button" onClick={startConfirming} className="justify-self-start rounded-lg border border-border bg-surface px-3 py-1.5 font-medium hover:bg-surface-2">Check again</button>
            </div>
          ) : null}

          {phase === Phase.Blocked || phase === Phase.Popup ? (
            <div className="mb-3 grid gap-2 rounded-lg border border-border bg-surface-2 px-4 py-4 text-[13px]">
              {phase === Phase.Popup ? (
                <p>Finish in the secure Inkress window. This page checks with Inkress when you close it.</p>
              ) : (
                <>
                  <p>The secure checkout did not load here. Open it in its own window instead.</p>
                  <button type="button" onClick={() => handle.current?.openPopup()} className="inline-flex h-8 items-center gap-1.5 justify-self-start rounded-lg bg-brand px-3 font-medium text-brand-fg hover:opacity-90">
                    <ExternalLink className="h-3.5 w-3.5" />Open secure checkout
                  </button>
                  {fallbackUrl ? <a href={fallbackUrl} className="text-[12px] text-muted underline">Or go to the Inkress page</a> : null}
                </>
              )}
            </div>
          ) : null}

          {phase === Phase.Confirming ? (
            <p className="mb-2 flex items-center gap-2 text-[13px] text-muted"><Loader2 className="h-3.5 w-3.5 animate-spin" />Confirming with Inkress…</p>
          ) : null}

          {/* Mounted for the whole attempt (a 3-D Secure step lives in it); hidden, never unmounted, once settled. */}
          <div className={showFrame && phase !== Phase.Blocked ? undefined : "hidden"} data-inkress-step={inkressStep}>
            <InkressCheckout url={embedUrl} onEvent={onEvent} handleRef={handle} />
          </div>
        </div>
      </div>
    </Card>
  );
}
