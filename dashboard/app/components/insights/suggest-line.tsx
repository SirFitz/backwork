// The "Suggestions" line on a request (BAC-93), beside "Why": one neutral line naming the largest
// hint, "+N more" and a details toggle. Clicking the text opens and scrolls to the hop it is about,
// as the Why line does. Grey and neutral: a hint is not a fault, so no colour and no red. The
// hints load after the page has rendered: a thin skeleton while they do, a quiet note if they
// cannot be read, and nothing at all when there are none or they are switched off.
import { ChevronDown, ChevronRight } from "lucide-react";
import { useState } from "react";
import { Skeleton } from "~/components/ui";
import { SUGGESTION_KIND_LABEL, type Suggestion } from "~/lib/hops/suggest";
import type { HopId } from "~/lib/hops/types";
import { cn } from "~/lib/utils";
import { SuggestPhase, type SuggestState } from "./use-suggestions";

const LABEL = "shrink-0 text-2xs uppercase tracking-wide text-faint";

export function SuggestLine({ state, onShow }: { state: SuggestState; onShow: (hopId: HopId) => void }) {
  const [open, setOpen] = useState(false);
  if (state.phase === SuggestPhase.Idle) return null;
  if (state.phase === SuggestPhase.Loading) {
    return (
      <div data-suggestions="loading" className="mb-3 flex items-center gap-3" aria-busy="true">
        <span className={LABEL}>Suggestions</span>
        <Skeleton className="h-4 w-2/3" />
      </div>
    );
  }
  if (state.phase === SuggestPhase.Error) {
    return (
      <div data-suggestions="error" className="mb-3 flex items-baseline gap-3 text-[13px] text-muted">
        <span className={LABEL}>Suggestions</span>
        <span className="min-w-0 truncate">Suggestions could not be loaded just now ({state.message.slice(0, 80)}).</span>
      </div>
    );
  }
  const [first, ...rest] = state.suggestions;
  const target = first.hopIds[0] ?? null;
  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <div data-suggestions="ready" className="mb-3 text-[13px] leading-[18px]">
      <div className="flex min-w-0 items-baseline gap-3">
        <span className={LABEL}>Suggestions</span>
        {target ? (
          <button
            type="button"
            title={first.summary}
            onClick={() => onShow(target)}
            className="min-w-0 flex-1 cursor-pointer text-left text-fg hover:underline hover:decoration-border-strong hover:underline-offset-2"
          >
            <span className="block min-w-0 truncate md:line-clamp-2 md:whitespace-normal">{first.summary}</span>
          </button>
        ) : (
          <span className="min-w-0 flex-1 text-fg" title={first.summary}><span className="block truncate">{first.summary}</span></span>
        )}
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
          className="inline-flex shrink-0 items-center gap-0.5 whitespace-nowrap text-xs text-muted hover:text-fg"
        >
          <Chevron aria-hidden className="h-3.5 w-3.5" />
          {rest.length > 0 ? `+${rest.length} more` : "Details"}
        </button>
      </div>
      {open ? (
        <ul className="mt-2 divide-y divide-border rounded-lg border border-border bg-surface">
          {state.suggestions.map((s) => <SuggestionCard key={s.id} s={s} onShow={onShow} />)}
        </ul>
      ) : null}
    </div>
  );
}

/** One suggestion in full: what it is, the figures, the change in words and the sketch. */
export function SuggestionCard({ s, onShow }: { s: Suggestion; onShow?: (hopId: HopId) => void }) {
  const target = s.hopIds[0] ?? null;
  return (
    <li className="min-w-0 space-y-1.5 px-3 py-2.5" data-suggestion-kind={s.kind}>
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <span className="rounded border border-border bg-surface-2 px-1.5 py-px text-2xs font-medium text-muted">{SUGGESTION_KIND_LABEL[s.kind]}</span>
        <span className="min-w-0 text-fg">{s.summary}</span>
        {target && onShow ? (
          <button type="button" onClick={() => onShow(target)} className="text-xs text-brand hover:underline">Show on the path</button>
        ) : null}
      </div>
      <ul className="list-disc space-y-0.5 pl-5 text-xs text-muted">
        {s.evidence.map((e, i) => <li key={i}>{e}</li>)}
      </ul>
      <p className="text-xs text-fg">{s.advice}</p>
      {s.sketch ? <pre className={cn("scroll-thin overflow-x-auto whitespace-pre-wrap break-all rounded-md border border-border bg-surface-2 px-2.5 py-1.5 font-mono text-[12px] text-fg")}>{s.sketch}</pre> : null}
    </li>
  );
}
