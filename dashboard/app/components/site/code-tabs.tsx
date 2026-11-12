import { useState } from "react";
import { cn } from "~/lib/utils";

export enum Runtime {
  Node = "Node",
  Bun = "Bun",
  Elixir = "Elixir",
}

/** One line of a code sample. Comments render muted; commands get a prompt. */
export type CodeLine = { kind: "comment" | "command" | "plain"; text: string };

export const c = (text: string): CodeLine => ({ kind: "comment", text });
export const $ = (text: string): CodeLine => ({ kind: "command", text });
export const p = (text: string): CodeLine => ({ kind: "plain", text });

export enum CodeTone {
  Dark = "dark",
  Light = "light",
}

function Lines({ lines }: { lines: CodeLine[] }) {
  return (
    <pre className="overflow-x-auto px-5 py-4 font-mono text-[13px] leading-[1.8]">
      {lines.map((l, i) => (
        <div key={i} className={cn("min-h-[1.8em] whitespace-pre", l.kind === "comment" && "opacity-55")}>
          {l.kind === "command" && <span className="mr-3 select-none text-brand">$</span>}
          {l.text}
        </div>
      ))}
    </pre>
  );
}

const frame: Record<CodeTone, string> = {
  [CodeTone.Dark]: "bg-[oklch(0.2_0.01_265)] text-[oklch(0.92_0.006_265)] shadow-[0_30px_70px_-34px_oklch(0.2_0.02_265/0.5)]",
  [CodeTone.Light]: "border border-border bg-surface text-fg",
};

/** A code sample with one tab per runtime. Tabs are buttons, so they work by keyboard. */
export function CodeTabs({ samples, tone = CodeTone.Dark, footer, className }: {
  samples: Partial<Record<Runtime, CodeLine[]>>;
  tone?: CodeTone;
  footer?: React.ReactNode;
  className?: string;
}) {
  const runtimes = Object.keys(samples) as Runtime[];
  const [active, setActive] = useState<Runtime>(runtimes[0]);
  const divider = tone === CodeTone.Dark ? "border-white/10" : "border-border";
  return (
    <div className={cn("overflow-hidden rounded-2xl", frame[tone], className)}>
      {runtimes.length > 1 && (
        <div role="tablist" className={cn("flex gap-1 border-b px-3 pt-1.5", divider)}>
          {runtimes.map((r) => (
            <button
              key={r}
              type="button"
              role="tab"
              aria-selected={r === active}
              onClick={() => setActive(r)}
              className={cn(
                "-mb-px border-b-2 px-2.5 py-2 text-[12.5px] font-medium transition-colors",
                r === active ? "border-brand" : "border-transparent opacity-60 hover:opacity-100",
              )}
            >
              {r}
            </button>
          ))}
        </div>
      )}
      <Lines lines={samples[active] ?? []} />
      {footer && <div className={cn("border-t px-5 py-3.5 text-[13px]", divider)}>{footer}</div>}
    </div>
  );
}

/** A single code sample with no tabs. */
export function CodeBlock({ lines, tone = CodeTone.Light, className }: { lines: CodeLine[]; tone?: CodeTone; className?: string }) {
  return (
    <div className={cn("overflow-hidden rounded-xl", frame[tone], className)}>
      <Lines lines={lines} />
    </div>
  );
}

export const INSTALL: Record<Runtime, CodeLine[]> = {
  [Runtime.Node]: [c("# 1. Add the package"), $("npm install correlator"), p(""), c("# 2. Start your service with it. No code change."), $("node --import correlator/auto server.js")],
  [Runtime.Bun]: [c("# 1. Add the package"), $("bun add correlator"), p(""), c("# 2. Start your service with it. No code change."), $("bun --preload correlator/auto server.ts")],
  [Runtime.Elixir]: [c("# 1. mix.exs"), p('{:correlator, "~> 0.1"}'), p(""), c("# 2. application.ex, first line of start/2"), p("Correlator.setup()")],
};

export const AGENT: CodeLine[] = [c("# 3. On each server, once"), $("curl -fsSL https://backwork.dev/install.sh | sh -s -- --token <TOKEN>")];
