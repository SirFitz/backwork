// The marker a repeated call carries on the Path card (BAC-68): "N+1" or "repeated". Neutral, not a
// status colour: a repeat is a finding, not a failure. One line, truncates, so the 38 px row stays.
import { repeatChip, repeatSentence, type RepeatGroup } from "~/lib/hops/repeated";
import { cn } from "~/lib/utils";

export function RepeatChip({ group, className }: { group: RepeatGroup; className?: string }) {
  return (
    <span
      className={cn("inline-flex min-w-0 shrink-0 items-center truncate rounded-full border border-border bg-surface-2 px-1.5 py-px font-mono text-[10.5px] font-medium leading-[1.4] text-muted", className)}
      title={repeatSentence(group)}
    >
      {repeatChip(group)}
    </span>
  );
}
