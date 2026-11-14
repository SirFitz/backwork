// The "Why" line on a request (BAC-70): one neutral sentence naming where the time went, above
// "Where the time went". At most two lines on desktop, one truncated line on a phone with the full
// text on hover. Clicking it opens and scrolls to the culprit row on the Path card. No colour and
// no icon: a slow request is a finding, not a fault (faults stay in the red Alert box).
import type { HopId } from "~/lib/hops/types";
import { verdictShown, type Verdict } from "~/lib/hops/verdict";

export function WhyLine({ verdict, onShow }: { verdict: Verdict; onShow: (hopId: HopId) => void }) {
  if (!verdictShown(verdict)) return null;
  const text = verdict.detail ? `${verdict.sentence} ${verdict.detail}` : verdict.sentence;
  const culprit = verdict.culpritHopId;
  const body = <span className="block min-w-0 truncate md:line-clamp-2 md:whitespace-normal">{text}</span>;
  return (
    <div className="mb-3 flex min-w-0 items-baseline gap-3 text-[13px] leading-[18px]">
      <span className="shrink-0 text-2xs uppercase tracking-wide text-faint">Why</span>
      {culprit ? (
        <button
          type="button"
          className="min-w-0 flex-1 cursor-pointer text-left text-fg hover:underline hover:decoration-border-strong hover:underline-offset-2"
          title={text}
          onClick={() => onShow(culprit)}
        >
          {body}
        </button>
      ) : (
        <span className="min-w-0 flex-1 text-fg" title={text}>{body}</span>
      )}
    </div>
  );
}
