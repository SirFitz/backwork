// Settings card for automatic pins (BAC-78): two switches (admins only) and how many pins the
// organisation holds of its plan's cap.
import { useFetcher } from "@remix-run/react";
import { Card, CardHead } from "~/components/ui";
import type { AutoPinSettings } from "~/lib/pins";

/** The Settings action's intent for this card. */
export const AUTO_PINS_INTENT = "auto_pins";

export interface AutoPinView {
  settings: AutoPinSettings;
  count: number;
  limit: number;
  canManage: boolean;
}

function Switch({ name, label, checked, disabled }: { name: keyof AutoPinSettings; label: string; checked: boolean; disabled: boolean }) {
  const fetcher = useFetcher();
  const pending = fetcher.formData ? fetcher.formData.get("on") === "1" : checked;
  return (
    <li className="flex items-center justify-between gap-3 px-4 py-2.5 text-[13px]">
      <span className="min-w-0 text-fg">{label}</span>
      <fetcher.Form method="post" action="/settings">
        <input type="hidden" name="intent" value={AUTO_PINS_INTENT} />
        <input type="hidden" name="which" value={name} />
        <input type="hidden" name="on" value={pending ? "0" : "1"} />
        <button
          type="submit"
          role="switch"
          aria-checked={pending}
          aria-label={label}
          disabled={disabled}
          className="relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border border-border bg-surface-2 transition-colors disabled:opacity-60 aria-checked:border-brand aria-checked:bg-brand"
        >
          <span className={`inline-block h-3.5 w-3.5 rounded-full bg-surface shadow transition-transform ${pending ? "translate-x-[18px]" : "translate-x-[3px]"}`} />
        </button>
      </fetcher.Form>
    </li>
  );
}

export function AutoPinCard({ view }: { view: AutoPinView }) {
  return (
    <Card>
      <CardHead
        title="Pinned requests"
        sub={view.canManage ? "kept after their records expire" : "only an admin can change these"}
        right={<span className="font-mono text-[12.5px] text-muted">Pinned: {view.count} of {view.limit}</span>}
      />
      <ul className="divide-y divide-border border-t border-border">
        <Switch name="slow" label="Keep the slowest request of each day" checked={view.settings.slow} disabled={!view.canManage} />
        <Switch name="failed" label="Keep failed requests (up to 3 a day)" checked={view.settings.failed} disabled={!view.canManage} />
      </ul>
    </Card>
  );
}
