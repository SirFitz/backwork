// Insights > Fix first (BAC-74): the ranked rows, their skeleton and the notes for sources that did
// not contribute. Rows are 38 px: rank, kind, title, service, impact, why (wide screens), chevron.
import { Link } from "@remix-run/react";
import { ChevronRight, ListOrdered } from "lucide-react";
import { Badge, Empty, Skeleton } from "~/components/ui";
import {
  FIX_KINDS,
  FIX_KIND_LABEL,
  FIX_PAGE_ROWS,
  FIX_WINDOW_PHRASE,
  ItemTone,
  sourceNote,
  type FixItem,
  type FixKind,
  type FixWindow,
  type SourceState,
} from "~/lib/insights/fix-first";
import { cn } from "~/lib/utils";

export function FixListSkeleton({ rows = 8 }: { rows?: number }) {
  return (
    <div aria-busy="true" aria-label="Loading the list">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="flex h-[38px] items-center gap-3 border-b border-border px-4 last:border-b-0">
          <Skeleton className="h-3 w-4" />
          <Skeleton className="hidden h-4 w-16 sm:block" />
          <Skeleton className="h-3 flex-1" />
          <Skeleton className="h-3 w-20" />
        </div>
      ))}
    </div>
  );
}

function FixRow({ item, rank }: { item: FixItem; rank: number }) {
  return (
    <li>
      <Link
        to={item.href}
        prefetch="intent"
        title={`${item.detail}\n${item.why}`}
        className="flex h-[38px] min-w-0 items-center gap-3 border-b border-border px-4 text-[13px] hover:bg-surface-2/60"
      >
        <span className="w-5 shrink-0 text-right font-mono text-2xs tabular-nums text-faint">{rank}</span>
        <Badge className="hidden w-[5.5rem] shrink-0 justify-center sm:inline-flex">{FIX_KIND_LABEL[item.kind]}</Badge>
        <span className={cn("min-w-0 flex-1 truncate", item.mono ? "font-mono text-[12.5px]" : "font-medium")}>{item.title}</span>
        <span className="hidden w-32 shrink-0 truncate text-xs text-muted md:block">{item.service}</span>
        <span className={cn("shrink-0 text-right font-mono text-xs tabular-nums", item.tone === ItemTone.Warn ? "text-warn" : "text-fg")}>
          <span className="xl:hidden">{item.impactShort}</span>
          <span className="hidden xl:inline">{item.impactLabel}</span>
        </span>
        <span className="hidden w-72 shrink-0 truncate text-xs text-faint lg:block">{item.why}</span>
        <ChevronRight aria-hidden className="h-3.5 w-3.5 shrink-0 text-faint" />
      </Link>
    </li>
  );
}

/** The first `count` rows, ranked from 1. */
export function FixRows({ items, count }: { items: readonly FixItem[]; count: number }) {
  return (
    <ol>
      {items.slice(0, count).map((item, i) => <FixRow key={item.id} item={item} rank={i + 1} />)}
    </ol>
  );
}

export function SourceNotes({
  sources,
  errors,
  repeatsSampled = false,
}: {
  sources: Record<FixKind, SourceState>;
  errors: Partial<Record<FixKind, string>>;
  repeatsSampled?: boolean;
}) {
  const notes = FIX_KINDS.map((k) => ({ kind: k, text: sourceNote(k, sources[k]) })).filter((n): n is { kind: FixKind; text: string } => n.text !== null);
  if (!notes.length && !repeatsSampled) return null;
  return (
    <ul className="space-y-0.5 border-t border-border px-4 py-2 text-2xs text-muted">
      {notes.map((n) => (
        <li key={n.kind} title={errors[n.kind]}>{n.text}</li>
      ))}
      {repeatsSampled ? <li>Repeated calls sampled: only the newest request records of the window were checked, so savings are at least the figure shown.</li> : null}
    </ul>
  );
}

export function FixList({
  items,
  window,
  shown,
  onMore,
  filtered,
}: {
  items: readonly FixItem[];
  window: FixWindow;
  shown: number;
  onMore: () => void;
  /** A kind filter is on (changes the empty text). */
  filtered: boolean;
}) {
  if (!items.length) {
    return (
      <Empty
        icon={<ListOrdered className="h-5 w-5" />}
        title={filtered ? `Nothing of this kind stands out in the ${FIX_WINDOW_PHRASE[window]}.` : `Nothing stands out in the ${FIX_WINDOW_PHRASE[window]}.`}
      />
    );
  }
  return (
    <>
      <FixRows items={items} count={shown} />
      {items.length > shown ? (
        <div className="px-4 py-2">
          <button type="button" onClick={onMore} className="text-xs font-medium text-brand hover:underline">
            Show {Math.min(FIX_PAGE_ROWS, items.length - shown)} more
          </button>
        </div>
      ) : null}
    </>
  );
}
