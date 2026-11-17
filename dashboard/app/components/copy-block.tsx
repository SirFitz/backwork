import { useState } from "react";
import { Check, Copy } from "lucide-react";

/** A small button that copies TEXT to the clipboard. */
export function CopyButton({ text, label = "copy" }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        } catch {
          /* clipboard unavailable */
        }
      }}
      className="inline-flex items-center gap-1 rounded-md border border-border bg-surface px-2 py-1 text-2xs text-muted hover:text-fg"
    >
      {done ? <><Check className="h-3 w-3" /> copied</> : <><Copy className="h-3 w-3" /> {label}</>}
    </button>
  );
}

/** A monospaced block with a copy button. */
export function CodeBlock({ children }: { children: string }) {
  return (
    <div className="relative">
      <pre className="overflow-x-auto scroll-thin rounded-lg border border-border bg-surface-2 px-3.5 py-3 pr-16 font-mono text-2xs leading-relaxed text-fg/90">{children}</pre>
      <div className="absolute right-2 top-2"><CopyButton text={children} /></div>
    </div>
  );
}
