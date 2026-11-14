// The "still building" state of an Insights card (BAC-67): the first computation of a page can
// take longer than Remix waits for a slow stream (5 seconds), so the page shows this instead and
// asks the loader again every few seconds until the value is there. The computation keeps running
// on the server (a shared stale-while-revalidate compute), so the next request is served from it.
import { useRevalidator } from "@remix-run/react";
import { useEffect, useRef, useState } from "react";
import { RowsSkeleton } from "~/components/defer";

/** How often the page asks again while it is being built, in milliseconds. */
export const BUILD_POLL_MS = 3_000;
/** How many times it asks before telling the reader to reload. */
export const BUILD_POLL_MAX = 10;

export function Building({ what }: { what: string }) {
  const revalidator = useRevalidator();
  const tries = useRef(0);
  const [gaveUp, setGaveUp] = useState(false);
  useEffect(() => {
    if (gaveUp) return;
    const id = setTimeout(() => {
      tries.current += 1;
      if (tries.current >= BUILD_POLL_MAX) setGaveUp(true);
      else revalidator.revalidate();
    }, BUILD_POLL_MS);
    return () => clearTimeout(id);
  });
  return (
    <>
      <RowsSkeleton rows={4} />
      <p className="px-4 pb-4 text-center text-[13px] text-muted">
        {gaveUp ? `${what} is still being built. Reload the page in a minute.` : `Building ${what.toLowerCase()} for the first time. It takes a few seconds and will appear here.`}
      </p>
    </>
  );
}
