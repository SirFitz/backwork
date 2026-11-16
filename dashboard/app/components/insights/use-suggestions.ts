// The request view's suggestions (BAC-93). The rules run in the browser on the tree the page
// already built, so they cost the loader nothing. A request with nothing to suggest never calls the
// server; one that has hints asks `/suggestions` after the page has rendered, for the switches
// (organisation, project, service) and the cross-request figures, and shows the hints once the
// switches are known.
import { useEffect, useMemo, useState } from "react";
import { NO_CONTEXT, requestSuggestions, type Suggestion } from "~/lib/hops/suggest";
import { parseSuggestResponse, wantedHref, type SuggestResponse } from "~/lib/hops/suggest-wire";
import type { RepeatReport } from "~/lib/hops/repeated";
import type { RequestTree } from "~/lib/hops/types";

export const SuggestPhase = { Idle: "idle", Loading: "loading", Error: "error", Ready: "ready" } as const;
export type SuggestPhase = (typeof SuggestPhase)[keyof typeof SuggestPhase];

export type SuggestState =
  | { phase: typeof SuggestPhase.Idle }
  | { phase: typeof SuggestPhase.Loading }
  | { phase: typeof SuggestPhase.Error; message: string }
  | { phase: typeof SuggestPhase.Ready; suggestions: Suggestion[] };

type Fetched = { href: string; result: SuggestResponse } | { href: string; error: string };

export function useRequestSuggestions(tree: RequestTree, repeats: RepeatReport, projects: readonly string[]): SuggestState {
  const local = useMemo(() => requestSuggestions(tree, repeats, NO_CONTEXT), [tree, repeats]);
  const href = useMemo(
    () =>
      local.length === 0
        ? null
        : wantedHref({
            projects: [...projects],
            services: [...new Set(local.map((s) => s.service))].sort(),
            tables: [...new Set(local.map((s) => s.table).filter((t): t is string => t !== null))].sort(),
          }),
    [local, projects],
  );
  const [fetched, setFetched] = useState<Fetched | null>(null);
  useEffect(() => {
    if (!href) return;
    const ctl = new AbortController();
    fetch(href, { headers: { accept: "application/json" }, credentials: "same-origin", signal: ctl.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const parsed = parseSuggestResponse(await res.json());
        if (!parsed) throw new Error("unexpected answer");
        setFetched({ href, result: parsed });
      })
      .catch((e: unknown) => {
        if (ctl.signal.aborted) return;
        setFetched({ href, error: e instanceof Error ? e.message : "unavailable" });
      });
    return () => ctl.abort();
  }, [href]);

  return useMemo<SuggestState>(() => {
    if (!href) return { phase: SuggestPhase.Idle };
    if (!fetched || fetched.href !== href) return { phase: SuggestPhase.Loading };
    if ("error" in fetched) return { phase: SuggestPhase.Error, message: fetched.error };
    const { on, context } = fetched.result;
    const suggestions = requestSuggestions(tree, repeats, context ?? NO_CONTEXT).filter((s) => on[s.service] === true);
    return suggestions.length ? { phase: SuggestPhase.Ready, suggestions } : { phase: SuggestPhase.Idle };
  }, [href, fetched, tree, repeats]);
}
