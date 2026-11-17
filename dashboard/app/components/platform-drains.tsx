import { useState } from "react";
import { CodeBlock } from "~/components/copy-block";
import { NO_PUSH_GUIDES, drainGuides, type DrainPlatform } from "~/lib/ingest/drains/platforms";
import { cn } from "~/lib/utils";

/** Per-platform drain setup (BAC-98): one platform at a time, its URL and steps copyable. */
export function PlatformDrains({ baseUrl, token }: { baseUrl: string; token?: string }) {
  const guides = drainGuides(baseUrl, token);
  const [open, setOpen] = useState<DrainPlatform>(guides[0].platform);
  const g = guides.find((x) => x.platform === open) ?? guides[0];
  return (
    <div>
      <div role="tablist" aria-label="Platform" className="mb-2 flex flex-wrap gap-1.5">
        {guides.map((x) => (
          <button
            key={x.platform}
            type="button"
            role="tab"
            aria-selected={x.platform === open}
            onClick={() => setOpen(x.platform)}
            className={cn(
              "rounded-[7px] border px-[9px] py-[4px] text-[12.5px] font-medium",
              x.platform === open ? "border-border-strong bg-surface-2 text-fg" : "border-border text-muted hover:text-fg"
            )}
          >
            {x.label}
          </button>
        ))}
      </div>
      <ol className="space-y-2.5" role="tabpanel">
        {g.steps.map((s, i) => (
          <li key={i} className="text-[13px]">
            <div className="flex gap-2 text-fg/90"><span className="tabular-nums text-faint">{i + 1}.</span><span>{s.text}</span></div>
            {s.copy ? <div className="mt-1.5"><CodeBlock>{s.copy}</CodeBlock></div> : null}
          </li>
        ))}
      </ol>
      <p className="mt-2 text-2xs text-faint">{g.naming} Lines get the same switches, sensitive-data filter and request links as the agent&apos;s.</p>
      <p className="mt-1 text-2xs text-faint">{NO_PUSH_GUIDES.map((n) => `${n.label}: ${n.why}`).join(" ")}</p>
    </div>
  );
}
