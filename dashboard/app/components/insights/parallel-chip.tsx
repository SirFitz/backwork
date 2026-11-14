// The marker a call carries on the Path card when it ran back to back with siblings that could run
// together (BAC-71). Neutral, not a status colour: it is a possibility, not a failure. One line,
// truncates, so the 38 px row stays.
import { PARALLEL_CHIP, parallelSentence, type ParallelCandidate } from "~/lib/hops/concurrency";
import { cn } from "~/lib/utils";

export function ParallelChip({ candidate, className }: { candidate: ParallelCandidate; className?: string }) {
  return (
    <span
      className={cn("inline-flex min-w-0 shrink items-center truncate rounded-full border border-border bg-surface-2 px-1.5 py-px text-[10.5px] font-medium leading-[1.4] text-muted", className)}
      title={parallelSentence(candidate)}
    >
      {PARALLEL_CHIP}
    </span>
  );
}
