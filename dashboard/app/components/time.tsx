// Times shown to a person, without hydration mismatches (React #418/#425).
//
// The server renders in its own time zone (UTC in the container) and at its own "now"; the
// browser hydrates later, in the viewer's zone. Anything formatted from the clock or the zone
// therefore differs between the two renders. These components render a fixed UTC form on the
// server and during hydration, then the viewer's local form once hydrated.
import { useSyncExternalStore } from "react";
import { fmtClock, timeAgo } from "~/lib/utils";

const subscribe = (): (() => void) => () => {};

/** False on the server and during hydration, true afterwards (re-renders once). */
export function useHydrated(): boolean {
  return useSyncExternalStore(subscribe, () => true, () => false);
}

/** HH:MM:SS.mmm in UTC, the same on every machine. */
export function fmtClockUtc(ts: number): string {
  return new Date(ts).toISOString().slice(11, 23);
}

/** A clock time: `HH:MM:SS.mmm` local once hydrated. `seconds` drops the milliseconds. */
export function Clock({ ts, seconds = false, className }: { ts: number; seconds?: boolean; className?: string }) {
  const hydrated = useHydrated();
  const text = hydrated ? fmtClock(ts) : fmtClockUtc(ts);
  return (
    <time dateTime={new Date(ts).toISOString()} className={className} suppressHydrationWarning>
      {seconds ? text.slice(0, 8) : text}
    </time>
  );
}

/** "3m ago", from the viewer's clock once hydrated; the absolute UTC time before that. */
export function Ago({ ts, className }: { ts: number; className?: string }) {
  const hydrated = useHydrated();
  const iso = new Date(ts).toISOString();
  return (
    <time dateTime={iso} title={iso} className={className} suppressHydrationWarning>
      {hydrated ? timeAgo(ts) : `${iso.slice(0, 16).replace("T", " ")} UTC`}
    </time>
  );
}

/** A calendar date, local once hydrated. */
export function LocalDate({ ts, className }: { ts: number; className?: string }) {
  const hydrated = useHydrated();
  const iso = new Date(ts).toISOString();
  return (
    <time dateTime={iso} className={className} suppressHydrationWarning>
      {hydrated ? new Date(ts).toLocaleDateString() : iso.slice(0, 10)}
    </time>
  );
}
