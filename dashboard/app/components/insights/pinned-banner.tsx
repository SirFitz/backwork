// The request view's note when it shows a pinned copy (BAC-78). Neutral: an expired request is
// not a fault.
import { Pin } from "lucide-react";
import { useHydrated } from "~/components/time";
import { fmtPinnedAt, type PinnedCopyInfo } from "~/lib/pins";

export function PinnedBanner({ copy }: { copy: PinnedCopyInfo }) {
  const local = useHydrated();
  return (
    <div className="mb-3 flex items-start gap-2 rounded-lg border border-border bg-surface-2 px-3 py-2 text-[12.5px] text-muted" role="status">
      <Pin className="mt-0.5 h-3.5 w-3.5 shrink-0 text-faint" />
      <span>
        Pinned copy saved <span suppressHydrationWarning className="font-medium text-fg">{fmtPinnedAt(copy.pinnedAt, local)}</span>. The live records have expired.
        {copy.trimmed ? " It was over 2 MB, so its oldest log lines (and, if needed, records) were left out." : ""}
      </span>
    </div>
  );
}
