import { useState } from "react";
import { CodeBlock } from "~/components/copy-block";
import { cloudGuides, type CloudSource } from "~/lib/ingest/cloud/sources";
import { cn } from "~/lib/utils";

const Mode = { Console: "console", Cli: "cli" } as const;
type Mode = (typeof Mode)[keyof typeof Mode];

function Tab({ on, onClick, children }: { on: boolean; onClick: () => void; children: string }) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={on}
      onClick={onClick}
      className={cn("rounded-[7px] border px-[9px] py-[4px] text-[12.5px] font-medium", on ? "border-border-strong bg-surface-2 text-fg" : "border-border text-muted hover:text-fg")}
    >
      {children}
    </button>
  );
}

/** Cloud push setup (BAC-99): AWS CloudWatch via Firehose, GCP Cloud Logging via Pub/Sub, console or CLI. */
export function CloudPush({ baseUrl, token }: { baseUrl: string; token?: string }) {
  const guides = cloudGuides(baseUrl, token);
  const [open, setOpen] = useState<CloudSource>(guides[0].source);
  const [mode, setMode] = useState<Mode>(Mode.Console);
  const g = guides.find((x) => x.source === open) ?? guides[0];
  const steps = mode === Mode.Console ? g.console : g.cli;
  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center gap-1.5">
        <div role="tablist" aria-label="Cloud" className="flex flex-wrap gap-1.5">
          {guides.map((x) => <Tab key={x.source} on={x.source === open} onClick={() => setOpen(x.source)}>{x.label}</Tab>)}
        </div>
        <div role="tablist" aria-label="Setup with" className="ml-auto flex gap-1.5">
          <Tab on={mode === Mode.Console} onClick={() => setMode(Mode.Console)}>Console</Tab>
          <Tab on={mode === Mode.Cli} onClick={() => setMode(Mode.Cli)}>CLI</Tab>
        </div>
      </div>
      <ol className="space-y-2.5" role="tabpanel">
        {steps.map((s, i) => (
          <li key={i} className="text-[13px]">
            <div className="flex gap-2 text-fg/90"><span className="tabular-nums text-faint">{i + 1}.</span><span>{s.text}</span></div>
            {s.copy ? <div className="mt-1.5"><CodeBlock>{s.copy}</CodeBlock></div> : null}
          </li>
        ))}
      </ol>
      <p className="mt-2 text-2xs text-faint">{g.naming} backwork keeps no cloud credentials: your cloud pushes with the project token.</p>
    </div>
  );
}
