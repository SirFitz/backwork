import { ArrowLeft, Copy, CornerDownRight, Database, OctagonX, Search, Unplug } from "lucide-react";
import { cn } from "~/lib/utils";

// A static picture of backwork's request view, with sample data, for the public site.
// It mirrors the approved design frame (BAC-44); it is not wired to any data.

enum Dir { In = "in", Out = "out" }
enum State { Finished, Error, Open, Stalled }

interface Svc { name: string; color: string }
const API: Svc = { name: "commerce-api", color: "oklch(0.62 0.12 240)" };
const PAY: Svc = { name: "commerce-payments", color: "oklch(0.6 0.15 290)" };

interface Hop {
  depth: number;
  dir: Dir;
  svc: Svc;
  method: string;
  label: string;
  via: string;
  state: State;
  status: string;
  took: string;
  start: number; // seconds from the start of the request
  length: number;
  note?: string;
  store?: boolean;
}

const SCALE = 30.2;
const HOPS: Hop[] = [
  { depth: 0, dir: Dir.In, svc: API, method: "POST", label: "/payouts/:id/release", via: "http", state: State.Error, status: "504", took: "30.02 s", start: 0, length: 30.02 },
  { depth: 1, dir: Dir.Out, svc: API, method: "POST", label: "payments.internal", via: "http", state: State.Error, status: "error", took: "30.00 s", start: 0.18, length: 30, note: "TransportError" },
  { depth: 2, dir: Dir.In, svc: PAY, method: "POST", label: "/transfers", via: "http", state: State.Open, status: "open", took: "4 m 12 s +", start: 0.36, length: 0 },
  { depth: 3, dir: Dir.Out, svc: PAY, method: "select", label: "payments-db", via: "db", state: State.Finished, status: "ok", took: "2.1 ms", start: 0.37, length: 0.002, store: true },
  { depth: 3, dir: Dir.Out, svc: PAY, method: "POST", label: "bank-gw.internal", via: "http", state: State.Stalled, status: "stopped here", took: "4 m 12 s +", start: 0.38, length: 0 },
];

const LOG = [
  ["02:14:07.412", "info", "bank transfer submitted ref=TRF-88213"],
  ["02:14:13.418", "warn", "bank gateway slow, still waiting (6s)"],
  ["02:14:19.870", "warn", "bank gateway slow, still waiting (12s)"],
] as const;

function Badge({ text, tone }: { text: string; tone: "ok" | "err" | "neutral" }) {
  return (
    <span className={cn(
      "inline-flex items-center whitespace-nowrap rounded px-1.5 py-px text-[11px] font-medium ring-1 ring-inset",
      tone === "err" && "bg-err/10 text-err ring-err/25",
      tone === "ok" && "bg-ok/10 text-ok ring-ok/25",
      tone === "neutral" && "bg-surface-2 text-muted ring-border",
    )}>{text}</span>
  );
}

function toneOf(h: Hop): "ok" | "err" | "neutral" {
  if (h.state === State.Error || h.state === State.Stalled) return "err";
  return h.status === "ok" || h.status === "open" ? "neutral" : "ok";
}

function Bar({ h }: { h: Hop }) {
  const open = h.state === State.Open || h.state === State.Stalled;
  const left = (h.start / SCALE) * 100;
  const width = open ? 100 - left : Math.max((h.length / SCALE) * 100, 0.9);
  const bad = h.state === State.Error || h.state === State.Stalled;
  const style = { left: `${left}%`, width: `${width}%`, ["--c" as string]: h.svc.color } as React.CSSProperties;
  return (
    <span className="relative block h-4 rounded bg-fg/5">
      <span
        style={style}
        className={cn(
          "absolute top-0 h-4 min-w-[3px] rounded",
          open
            ? "rounded-r-none border-[1.5px] border-r-0 border-dashed border-[color:var(--c)] bg-[repeating-linear-gradient(135deg,color-mix(in_oklch,var(--c)_45%,transparent)_0_5px,transparent_5px_10px)]"
            : h.dir === Dir.In ? "bg-[color:var(--c)]" : "bg-[color-mix(in_oklch,var(--c)_22%,transparent)] shadow-[inset_0_0_0_1.5px_var(--c)]",
          h.store && "bg-muted/40 shadow-none",
          bad && "outline outline-[1.5px] outline-offset-[1.5px] outline-err",
        )}
      />
    </span>
  );
}

function HopText({ h }: { h: Hop }) {
  return (
    <span className="flex min-w-0 items-center gap-1.5 whitespace-nowrap" style={{ paddingLeft: `${h.depth * 18}px` }}>
      {h.depth > 0 && <CornerDownRight className="-ml-4 -mr-0.5 h-3.5 w-3.5 shrink-0 text-border-strong" />}
      <span className="min-w-[27px] rounded-[3px] border border-border bg-bg px-1 text-center font-mono text-[9.5px] uppercase leading-[1.5] text-faint">{h.dir}</span>
      <i className="h-2 w-2 shrink-0 rounded-full" style={{ background: h.svc.color }} />
      {h.dir === Dir.In && <b className="font-semibold">{h.svc.name}</b>}
      {h.store && <Database className="h-3.5 w-3.5 shrink-0 text-faint" />}
      <span className="truncate font-mono text-[12.5px]"><span className="text-faint">{h.method}</span> {h.label}</span>
      {h.note && <span className="truncate text-[11px] text-faint">{h.note}</span>}
    </span>
  );
}

/** Desktop request view: the full table with time bars. */
export function RequestPreview({ query }: { query?: string }) {
  return (
    <div className="bg-bg text-[13.5px] leading-[1.45] text-fg">
      {query !== undefined && (
        <div className="flex items-center gap-3 border-b border-border px-6 py-3">
          <div className="flex h-9 max-w-xl flex-1 items-center gap-2 rounded-lg border border-border bg-surface px-3 text-[13px] text-faint">
            <Search className="h-4 w-4" /><span className="truncate">Find a request: paste a trace ID, request ID or linked ID</span>
          </div>
        </div>
      )}
      <div className="p-6">
        <span className="mb-3.5 inline-flex items-center gap-1.5 text-[13px] text-muted"><ArrowLeft className="h-4 w-4" /> Requests</span>
        <div className="mb-4 flex items-start justify-between gap-8">
          <div>
            <h3 className="flex flex-wrap items-center gap-2.5 font-mono text-[21px] font-semibold tracking-tight">
              <span className="font-medium text-faint">POST</span> /payouts/:id/release <Badge text="504" tone="err" />
            </h3>
            <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[12.5px] text-muted">
              <span>Started <b className="font-mono font-medium text-fg">02:14:07.031</b> today</span>
              <span>Took <b className="font-mono font-medium text-fg">30.02 s</b></span>
              <span><b className="font-medium text-fg">2</b> services</span>
              <span><b className="font-medium text-fg">5</b> hops</span>
              <span className="text-err"><b className="font-medium">2</b> gaps</span>
            </div>
          </div>
          <dl className="m-0 hidden gap-1.5 text-[12px] lg:grid">
            {[["Trace", "9c2f41d07be3a6158d04f2c7b91e60aa"], ["x-request-id", "3f6c2a9e-51d7-4b0a-9c1e-0d7a44be2f18"], ["Linked", "payout_id PO-88213"]].map(([k, v]) => (
              <div key={k} className="flex items-center justify-end gap-2.5">
                <dt className="text-[10.5px] uppercase tracking-wide text-faint">{k}</dt>
                <dd className="m-0 inline-flex items-center gap-1.5 whitespace-nowrap font-mono text-[11.5px]">{v}{k === "Trace" && <Copy className="h-3.5 w-3.5 text-faint" />}</dd>
              </div>
            ))}
          </dl>
        </div>
        <div className="mb-4 rounded-xl border border-err/30 bg-err/5 px-4 py-3 text-[13px]">
          <div className="flex gap-2.5"><OctagonX className="mt-0.5 h-[17px] w-[17px] shrink-0 text-err" />
            <div><b className="font-semibold">Stopped in commerce-payments.</b> The call to <span className="font-mono">bank-gw.internal</span> started at <span className="font-mono">02:14:07.412</span> and never finished. Last log line for this request: <span className="font-mono">02:14:19.870</span>.</div>
          </div>
          <div className="mt-2.5 flex gap-2.5 border-t border-err/15 pt-2.5"><Unplug className="mt-0.5 h-[17px] w-[17px] shrink-0 text-warn" />
            <div><b className="font-semibold">One call was never received.</b> A job sent to queue <span className="font-mono">notifications</span> has no record on the other side.</div>
          </div>
        </div>
        <section className="rounded-xl border border-border bg-surface">
          <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
            <div><h4 className="text-[15px] font-semibold">Path</h4><p className="text-[11px] text-faint">Every hop this request made, parent to child</p></div>
            <div className="hidden items-center gap-3.5 text-[11px] text-muted sm:flex">
              <span className="flex items-center gap-1.5"><i className="h-2 w-2 rounded-full" style={{ background: API.color }} />{API.name}</span>
              <span className="flex items-center gap-1.5"><i className="h-2 w-2 rounded-full" style={{ background: PAY.color }} />{PAY.name}</span>
            </div>
          </div>
          <div className="grid min-h-8 grid-cols-[minmax(0,1fr)_44px_96px_84px_minmax(0,300px)] items-center gap-x-3 border-b border-border px-4 text-[11px] font-medium uppercase tracking-wide text-faint">
            <span>Hop</span><span>Via</span><span>Status</span><span className="text-right">Took</span>
            <span className="flex justify-between font-mono normal-case tracking-normal"><span>0</span><span>10 s</span><span>20 s</span><span>30 s</span></span>
          </div>
          {HOPS.map((h, i) => (
            <div key={i} className={cn("grid min-h-[38px] grid-cols-[minmax(0,1fr)_44px_96px_84px_minmax(0,300px)] items-center gap-x-3 border-b border-border px-4", h.state === State.Stalled && "bg-surface-2")}>
              <HopText h={h} />
              <span className="font-mono text-[11.5px] text-faint">{h.via}</span>
              <span><Badge text={h.status} tone={toneOf(h)} /></span>
              <span className="text-right font-mono text-[12.5px]">{h.took}</span>
              <Bar h={h} />
            </div>
          ))}
          <div className="bg-surface-2 px-4 pb-4 pt-3" style={{ paddingLeft: "112px" }}>
            <div className="flex flex-wrap gap-x-5 gap-y-1 text-[11.5px] text-muted">
              {[["Hop", "c41f7a0be2d95638"], ["Adapter", "fetch"], ["Started", "02:14:07.412"], ["Ended", "no end record"]].map(([k, v]) => (
                <span key={k}><em className="not-italic text-faint">{k}</em> <b className="font-mono font-medium text-fg">{v}</b></span>
              ))}
            </div>
            <div className="mt-2.5 rounded-lg border border-border bg-bg px-3 py-2 font-mono text-[12px] leading-[1.75]">
              {LOG.map(([t, lvl, m]) => (
                <div key={t} className="grid grid-cols-[96px_40px_1fr] gap-2.5">
                  <span className="text-faint">{t}</span><span className={lvl === "warn" ? "text-warn" : "text-muted"}>{lvl}</span><span className="truncate">{m}</span>
                </div>
              ))}
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}

/** Phone request view: hops stacked, each with its own bar, nothing scrolls sideways. */
export function RequestPreviewCompact() {
  return (
    <div className="bg-bg p-4 text-[13px] text-fg">
      <h3 className="flex flex-wrap items-center gap-2 font-mono text-[15px] font-semibold"><span className="font-medium text-faint">POST</span> /payouts/:id/release <Badge text="504" tone="err" /></h3>
      <div className="mt-1.5 flex flex-wrap gap-x-3 text-[12px] text-muted"><span>Took <b className="font-mono text-fg">30.02 s</b></span><span className="text-err"><b>2</b> gaps</span></div>
      <div className="mt-3 flex gap-2 rounded-xl border border-err/30 bg-err/5 px-3 py-2.5 text-[12.5px]">
        <OctagonX className="mt-0.5 h-4 w-4 shrink-0 text-err" />
        <div><b className="font-semibold">Stopped in commerce-payments.</b> The call to <span className="font-mono">bank-gw.internal</span> never finished.</div>
      </div>
      <div className="mt-3 overflow-hidden rounded-xl border border-border bg-surface">
        {HOPS.filter((h) => !h.store).map((h, i) => (
          <div key={i} className="border-b border-border px-3 py-2.5 last:border-b-0" style={{ paddingLeft: `${12 + h.depth * 12}px` }}>
            <div className="flex min-w-0 items-center gap-1.5">
              <span className="rounded-[3px] border border-border px-1 font-mono text-[9px] uppercase text-faint">{h.dir}</span>
              <i className="h-2 w-2 shrink-0 rounded-full" style={{ background: h.svc.color }} />
              <span className="truncate font-mono text-[12px]">{h.dir === Dir.In ? <b className="font-sans font-semibold">{h.svc.name} </b> : null}{h.method} {h.label}</span>
            </div>
            <div className="mt-1 font-mono text-[11px] text-faint">{h.via} · {h.status} · {h.took}</div>
            <div className="mt-1.5"><Bar h={h} /></div>
          </div>
        ))}
      </div>
    </div>
  );
}
