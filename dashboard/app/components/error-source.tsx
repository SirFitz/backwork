import { ErrorSource } from "~/lib/error-kinds";

const LABELS: Readonly<Record<ErrorSource, { text: string; title: string }>> = {
  [ErrorSource.Reported]: { text: "reported", title: "Posted by the service to /ingest/errors" },
  [ErrorSource.Log]: { text: "log", title: "From error-level log lines" },
  [ErrorSource.Request]: { text: "request", title: "From requests that ended with a 5xx status" },
};

/** Where an error group's events come from, as a small label (BAC-85). */
export function ErrorSourceLabel({ source }: { source: ErrorSource }) {
  const l = LABELS[source] ?? LABELS[ErrorSource.Reported];
  return (
    <span title={l.title} className="rounded border border-border px-1.5 py-px text-[11px] font-medium leading-4 text-faint">
      {l.text}
    </span>
  );
}
