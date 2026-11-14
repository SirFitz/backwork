// The "vs last week" chip of the Performance tables (BAC-73, insights plan 06 section D). Amber
// for slower or more errors, neutral otherwise; never red. Wording from `compareChip` (pure).
import { Badge } from "~/components/ui";
import { ChipTone, compareChip, type CompareRow } from "~/lib/hops/compare";

export function CompareChip({ row }: { row: CompareRow | undefined }) {
  if (!row) return <span className="text-2xs text-faint" title="nothing recorded the same hours last week">no baseline</span>;
  const chip = compareChip(row);
  return (
    <span title={`vs the same hours last week: ${chip.detail}`}>
      <Badge tone={chip.tone === ChipTone.Warn ? "warn" : "neutral"} className="whitespace-nowrap">{chip.text}</Badge>
    </span>
  );
}
