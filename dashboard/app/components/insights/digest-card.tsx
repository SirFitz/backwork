// The Weekly digest card on /alerts (BAC-77). Owners and admins choose the day, the hour (UTC,
// with the local equivalent beside it), the channels and whether owners and admins get it by
// email; "Send a test now" sends this week's digest at once without using up the week. Everyone
// else sees a one-line summary. Imports only pure modules: this file runs in the browser.

import { useFetcher } from "@remix-run/react";
import { useEffect, useState } from "react";
import { Check, Send, X } from "lucide-react";
import { Badge, Card, CardHead } from "~/components/ui";
import { FIELD } from "~/components/insights/alert-form-fields";
import { WEEKDAYS, WEEKDAY_LABEL, isWeekday, localTimeHint, scheduleText, type Weekday } from "~/lib/digest/schedule";
import { DigestIntent, type DigestActionResult, type DigestCardData } from "~/lib/digest/settings";
import { cn } from "~/lib/utils";

const LABEL = "text-2xs font-medium text-muted";
const HOURS: readonly number[] = Array.from({ length: 24 }, (_, h) => h);

/** "08:00 UTC, 03:00 your time": the local half is added after hydration (the server has no zone). */
function useLocalHint(weekday: Weekday, hourUtc: number): string | null {
  const [hint, setHint] = useState<string | null>(null);
  useEffect(() => {
    try {
      setHint(localTimeHint(weekday, hourUtc, Date.now()));
    } catch {
      setHint(null);
    }
  }, [weekday, hourUtc]);
  return hint;
}

function Summary({ d }: { d: DigestCardData }) {
  const s = d.settings;
  return s.enabled ? <>on, {scheduleText(s.weekday, s.hourUtc)}</> : <>off</>;
}

function TestSend({ disabled }: { disabled: boolean }) {
  const fetcher = useFetcher<DigestActionResult>();
  const busy = fetcher.state !== "idle";
  const res = fetcher.data && fetcher.data.intent === DigestIntent.Test ? fetcher.data : null;
  return (
    <fetcher.Form method="post" className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
      <input type="hidden" name="intent" value={DigestIntent.Test} />
      <button
        type="submit"
        disabled={disabled || busy}
        className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-border px-3 text-[13px] font-medium hover:bg-surface-2 disabled:opacity-60"
        title="Builds this week's digest and sends it to the saved destinations now; the scheduled one still goes out"
      >
        <Send className="h-3.5 w-3.5" /> {busy ? "Sending" : "Send a test now"}
      </button>
      {res ? (
        <p role="status" className={cn("inline-flex min-w-0 items-start gap-1 text-2xs", res.ok ? "text-muted" : "text-warn")}>
          {res.ok ? <Check className="mt-px h-3 w-3 shrink-0 text-ok" /> : <X className="mt-px h-3 w-3 shrink-0" />}
          <span className="min-w-0 break-words">
            {res.line}
            {res.ok && res.quiet ? " (a quiet week: the short message)" : ""}
          </span>
        </p>
      ) : null}
    </fetcher.Form>
  );
}

export function DigestCard({ d }: { d: DigestCardData }) {
  const save = useFetcher<DigestActionResult>();
  const [weekday, setWeekday] = useState<Weekday>(d.settings.weekday);
  const [hourUtc, setHourUtc] = useState<number>(d.settings.hourUtc);
  const local = useLocalHint(weekday, hourUtc);
  const saving = save.state !== "idle";
  const saved = save.data && save.data.intent === DigestIntent.Save ? save.data : null;
  const status = d.lastError ? <span className="text-warn">{d.lastError}</span> : d.lastSent ? <span>{d.lastSent}</span> : <span>Not sent yet</span>;

  if (!d.canManage) {
    return (
      <Card>
        <CardHead title="Weekly digest" sub={<Summary d={d} />} />
        <p className="px-4 py-3 text-2xs text-muted">{["Owners and admins choose when it is sent and where.", d.lastSent ? `${d.lastSent}.` : null].filter(Boolean).join(" ")}</p>
      </Card>
    );
  }

  return (
    <Card>
      <CardHead title="Weekly digest" sub={<Summary d={d} />} subTitle="One message a week: what to fix first, what got slower, errors, alerts, deploys and usage" />
      <save.Form method="post" className="space-y-3 p-4">
        <input type="hidden" name="intent" value={DigestIntent.Save} />
        <div className="grid gap-3 sm:grid-cols-[auto_minmax(0,12rem)_minmax(0,8rem)_minmax(0,1fr)] sm:items-end">
          <label className="inline-flex h-9 items-center gap-2 text-[13px] font-medium">
            <input type="checkbox" name="enabled" defaultChecked={d.settings.enabled} className="h-4 w-4 accent-[oklch(0.6_0.18_16)]" />
            Send weekly
          </label>
          <label className={LABEL}>
            Day
            <select name="weekday" value={weekday} onChange={(e) => { const v = Number(e.target.value); if (isWeekday(v)) setWeekday(v); }} className={cn(FIELD, "mt-1")}>
              {WEEKDAYS.map((w) => <option key={w} value={w}>{WEEKDAY_LABEL[w]}</option>)}
            </select>
          </label>
          <label className={LABEL}>
            Hour (UTC)
            <select name="hourUtc" value={hourUtc} onChange={(e) => setHourUtc(Number(e.target.value))} className={cn(FIELD, "mt-1 font-mono")}>
              {HOURS.map((h) => <option key={h} value={h}>{String(h).padStart(2, "0")}:00</option>)}
            </select>
          </label>
          <p className="min-h-9 text-2xs leading-9 text-muted" aria-live="polite">
            {scheduleText(weekday, hourUtc)}{local ? `, ${local}` : ""}
          </p>
        </div>
        <div>
          <div className="mb-1.5 text-2xs font-medium text-muted">Send to</div>
          <div className="flex flex-wrap gap-x-4 gap-y-2">
            {d.channels.map((c) => (
              <label key={c.id} className="inline-flex min-w-0 items-center gap-1.5 text-[13px]">
                <input type="checkbox" name="channelIds" value={c.id} defaultChecked={d.settings.channelIds.includes(c.id)} className="accent-[oklch(0.6_0.18_16)]" />
                <span className="truncate">{c.name}</span> <span className="text-2xs text-faint">{c.type}</span>
                {!c.enabled ? <Badge>disabled</Badge> : null}
              </label>
            ))}
            <label className="inline-flex items-center gap-1.5 text-[13px]">
              <input type="checkbox" name="emailAdmins" defaultChecked={d.settings.emailAdmins} className="accent-[oklch(0.6_0.18_16)]" />
              Email owners and admins
            </label>
          </div>
          {d.channels.length === 0 ? <p className="mt-1.5 text-2xs text-faint">No channels yet: add one below, or email owners and admins.</p> : null}
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <button type="submit" disabled={saving} className="inline-flex h-9 items-center justify-center rounded-lg bg-brand px-3 text-[13px] font-medium text-brand-fg hover:opacity-90 disabled:opacity-60">
            {saving ? "Saving" : "Save"}
          </button>
          {saved ? saved.ok ? <span className="text-2xs text-muted">Saved</span> : <span role="alert" className="text-2xs text-err">{saved.error}</span> : null}
        </div>
      </save.Form>
      <div className="flex flex-col gap-2 border-t border-border px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
        <TestSend disabled={saving} />
        <p className="min-w-0 break-words text-2xs text-faint">{status}</p>
      </div>
    </Card>
  );
}
