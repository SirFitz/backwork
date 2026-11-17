// Settings card for the AI write-up of query suggestions (BAC-93). The write-up is built but
// SWITCHED OFF: the switch is off by default, the monthly cap starts at 0, and no model key is
// configured on the server, so nothing is ever sent. The card says so, in words.
import { useFetcher } from "@remix-run/react";
import { Card, CardHead } from "~/components/ui";
import { aiStatusText, type AiSettings } from "~/lib/hops/suggest-ai";

/** The Settings action's intent for this card. */
export const SUGGEST_AI_INTENT = "suggest_ai";

export interface AiView {
  settings: AiSettings;
  keyConfigured: boolean;
  canManage: boolean;
  model: string;
}

export function AiCard({ view }: { view: AiView }) {
  const fetcher = useFetcher();
  const pending = fetcher.formData ? fetcher.formData.get("on") === "1" : view.settings.enabled;
  const cap = fetcher.formData ? Number(fetcher.formData.get("cap")) : view.settings.monthlyCap;
  const shown = { ...view.settings, enabled: pending, monthlyCap: cap };
  return (
    <Card>
      <CardHead title="Query suggestion write-ups" sub={view.canManage ? "an AI explanation for one query, off by default" : "only an admin can change these"} />
      <div className="divide-y divide-border border-t border-border">
        <div className="flex items-center justify-between gap-3 px-4 py-2.5 text-[13px]">
          <span className="min-w-0 text-fg">Write up a slow query with AI</span>
          <fetcher.Form method="post" action="/settings">
            <input type="hidden" name="intent" value={SUGGEST_AI_INTENT} />
            <input type="hidden" name="on" value={pending ? "0" : "1"} />
            <input type="hidden" name="cap" value={view.settings.monthlyCap} />
            <button
              type="submit"
              role="switch"
              aria-checked={pending}
              aria-label="Write up a slow query with AI"
              disabled={!view.canManage}
              className="relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border border-border bg-surface-2 transition-colors disabled:opacity-60 aria-checked:border-brand aria-checked:bg-brand"
            >
              <span className={`inline-block h-3.5 w-3.5 rounded-full bg-surface shadow transition-transform ${pending ? "translate-x-[18px]" : "translate-x-[3px]"}`} />
            </button>
          </fetcher.Form>
        </div>
        <fetcher.Form method="post" action="/settings" className="flex flex-wrap items-center justify-between gap-3 px-4 py-2.5 text-[13px]">
          <input type="hidden" name="intent" value={SUGGEST_AI_INTENT} />
          <input type="hidden" name="on" value={view.settings.enabled ? "1" : "0"} />
          <label htmlFor="suggest-ai-cap" className="text-fg">Most write-ups a month</label>
          <span className="flex items-center gap-2">
            <input
              id="suggest-ai-cap"
              name="cap"
              type="number"
              min={0}
              max={10000}
              defaultValue={view.settings.monthlyCap}
              disabled={!view.canManage}
              className="h-7 w-20 rounded-lg border border-border bg-surface px-2 text-right font-mono text-xs text-fg outline-none focus:border-brand/40 disabled:opacity-60"
            />
            <button type="submit" disabled={!view.canManage} className="h-7 rounded-lg border border-border px-2.5 text-xs font-medium hover:bg-surface-2 disabled:opacity-60">Save</button>
          </span>
        </fetcher.Form>
        <p data-ai-status className="px-4 py-2.5 text-xs text-muted">{aiStatusText(shown, view.keyConfigured)}</p>
      </div>
    </Card>
  );
}
