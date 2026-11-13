// Switches and the sensitive-data filter (design 19, frame 7), shared by Projects (one project,
// with the by-service grid) and Settings (the whole organisation). Each switch posts on its own
// through a fetcher, so the page never reloads and the panel stays open in place.

import { useFetcher } from "@remix-run/react";
import { useState } from "react";
import { Check, Plus, X } from "lucide-react";
import type { CellView, ControlResult, ControlsView, PatternView, SwitchView } from "~/lib/controls-view.server";
import { cn } from "~/lib/utils";

/** Mirrors ControlIntent in controls-view.server.ts (a client module cannot import server values). */
const Intent = {
  Switch: "control",
  PatternToggle: "pattern-toggle",
  PatternAdd: "pattern-add",
  PatternDelete: "pattern-delete",
} as const;

function Toggle({ on, disabled, label, busy }: { on: boolean; disabled: boolean; label: string; busy: boolean }) {
  return (
    <button
      type="submit"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      className={cn(
        "inline-flex h-[18px] w-[30px] shrink-0 rounded-full p-[2px] align-middle outline-none transition-colors focus-visible:ring-2 focus-visible:ring-brand/40",
        on ? "justify-end bg-fg" : "justify-start bg-border-strong",
        disabled && "cursor-not-allowed opacity-[0.38]",
        busy && "opacity-70"
      )}
    >
      <i className="h-[14px] w-[14px] rounded-full bg-bg" />
    </button>
  );
}

/** One switch that posts its own change. Shows the new state while the post is in flight. */
function ControlSwitch({
  feature,
  projectId,
  service,
  on,
  disabled,
  label,
}: {
  feature: string;
  projectId: string | null;
  service: string | null;
  on: boolean;
  disabled: boolean;
  label: string;
}) {
  const fetcher = useFetcher<ControlResult>();
  const pending = fetcher.formData ? fetcher.formData.get("enabled") === "1" : null;
  const failed = fetcher.state === "idle" && fetcher.data !== undefined && !fetcher.data.ok;
  const shown = pending ?? on;
  return (
    <fetcher.Form method="post" className="inline-flex" title={failed ? fetcher.data?.error : undefined}>
      <input type="hidden" name="intent" value={Intent.Switch} />
      <input type="hidden" name="feature" value={feature} />
      <input type="hidden" name="projectId" value={projectId ?? ""} />
      <input type="hidden" name="service" value={service ?? ""} />
      <input type="hidden" name="enabled" value={shown ? "0" : "1"} />
      <Toggle on={shown} disabled={disabled} label={label} busy={fetcher.state !== "idle"} />
    </fetcher.Form>
  );
}

function SwitchRow({ s, projectId, canManage }: { s: SwitchView; projectId: string | null; canManage: boolean }) {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-3 border-b border-border py-[9px] last:border-b-0">
      <div className="min-w-0">
        <b className="block text-[13px] font-medium">{s.label}</b>
        <span className="block text-xs text-muted">{s.lockedOff ? "Off for the whole organisation, on Settings." : s.meaning}</span>
      </div>
      <em className={cn("min-w-[20px] text-right text-[11.5px] not-italic", s.on ? "text-muted" : "text-faint")}>{s.on ? "On" : "Off"}</em>
      <ControlSwitch feature={s.feature} projectId={projectId} service={null} on={s.on} disabled={!canManage || s.lockedOff} label={s.label} />
    </div>
  );
}

function PatternChip({ p, canManage }: { p: PatternView; canManage: boolean }) {
  const toggle = useFetcher<ControlResult>();
  const remove = useFetcher<ControlResult>();
  const enabled = toggle.formData ? toggle.formData.get("enabled") === "1" : p.enabled;
  if (remove.formData) return null;
  const body = (
    <>
      {enabled ? <Check className="h-3 w-3 text-muted" /> : <X className="h-3 w-3 text-faint" />}
      <span className={cn(!enabled && "text-faint line-through")}>{p.label}</span>
    </>
  );
  const chip = "inline-flex items-center gap-[5px] rounded-md border border-border bg-bg px-2 py-[3px] text-xs";
  return (
    <span className="inline-flex items-center">
      {canManage ? (
        <toggle.Form method="post">
          <input type="hidden" name="intent" value={Intent.PatternToggle} />
          <input type="hidden" name="name" value={p.name} />
          <input type="hidden" name="enabled" value={enabled ? "0" : "1"} />
          <button type="submit" className={cn(chip, "hover:border-border-strong", !p.builtIn && "rounded-r-none")} aria-pressed={enabled} title={enabled ? "On: click to stop filtering this" : "Off: click to filter this again"}>
            {body}
          </button>
        </toggle.Form>
      ) : (
        <span className={chip}>{body}</span>
      )}
      {canManage && !p.builtIn ? (
        <remove.Form method="post">
          <input type="hidden" name="intent" value={Intent.PatternDelete} />
          <input type="hidden" name="name" value={p.name} />
          <button type="submit" aria-label={`Remove ${p.label}`} className="inline-flex h-[24px] items-center rounded-r-md border border-l-0 border-border bg-bg px-1.5 text-faint hover:text-err">
            <X className="h-3 w-3" />
          </button>
        </remove.Form>
      ) : null}
    </span>
  );
}

function AddPattern() {
  const fetcher = useFetcher<ControlResult>();
  const [open, setOpen] = useState(false);
  const done = fetcher.state === "idle" && fetcher.data?.ok;
  if (!open || done) {
    return (
      <button type="button" onClick={() => { setOpen(true); }} className="inline-flex h-[26px] items-center gap-[5px] rounded-md border border-border bg-surface px-[9px] text-xs font-medium hover:border-border-strong">
        <Plus className="h-[13px] w-[13px]" />
        Add a pattern
      </button>
    );
  }
  const field = "h-8 rounded-md border border-border bg-bg px-2.5 text-xs outline-none focus:border-brand/40";
  return (
    <fetcher.Form method="post" className="mt-1 flex w-full flex-wrap items-center gap-2">
      <input type="hidden" name="intent" value={Intent.PatternAdd} />
      <input name="name" required maxLength={60} placeholder="Name, e.g. Member number" className={cn(field, "min-w-0 flex-1 basis-40")} aria-label="Pattern name" />
      <input name="pattern" required maxLength={500} placeholder="Regular expression, e.g. \b\d{12}\b" className={cn(field, "min-w-0 flex-[2] basis-48 font-mono")} aria-label="Pattern" />
      <button type="submit" className="inline-flex h-8 items-center rounded-md bg-brand px-3 text-xs font-medium text-brand-fg hover:opacity-90">Add</button>
      <button type="button" onClick={() => setOpen(false)} className="h-8 px-1 text-xs text-muted hover:text-fg">Cancel</button>
      {fetcher.data && !fetcher.data.ok ? <p className="w-full text-xs text-err">{fetcher.data.error}</p> : null}
    </fetcher.Form>
  );
}

function Cell({ c, projectId, service, canManage, label }: { c: CellView; projectId: string; service: string; canManage: boolean; label: string }) {
  return (
    <td className="border-b border-border px-3 py-2 text-center">
      <ControlSwitch feature={c.feature} projectId={projectId} service={service} on={c.on && !c.disabled} disabled={!canManage || c.disabled} label={`${label} for ${service}`} />
    </td>
  );
}

/** A named run of switches (Settings splits what is stored from the detail kept inside each request). */
export interface SwitchGroup {
  title: string;
  features: readonly string[];
}

export function DataControlsPanel({
  view,
  heading,
  gridHeads,
  groups,
}: {
  view: ControlsView;
  heading: string;
  gridHeads: Record<string, string>;
  groups?: readonly SwitchGroup[];
}) {
  const builtIn = view.patterns.filter((p) => p.builtIn);
  const own = view.patterns.filter((p) => !p.builtIn);
  const listed = new Set(groups?.flatMap((g) => g.features) ?? []);
  const rows = (list: SwitchView[]) =>
    list.map((s) => <SwitchRow key={s.feature} s={s} projectId={view.projectId} canManage={view.canManage} />);
  return (
    <div>
      <div className="grid gap-y-5 md:grid-cols-2 md:gap-x-9">
        <div className="min-w-0">
          <h3 className="text-[13.5px] font-semibold tracking-tight">{heading}</h3>
          {groups ? (
            <div className="mt-1.5 space-y-4">
              {groups.map((g) => (
                <div key={g.title}>
                  <div className="mb-0.5 text-2xs uppercase tracking-wide text-faint">{g.title}</div>
                  {rows(view.switches.filter((s) => g.features.includes(s.feature)))}
                </div>
              ))}
              {view.switches.some((s) => !listed.has(s.feature)) ? <div>{rows(view.switches.filter((s) => !listed.has(s.feature)))}</div> : null}
            </div>
          ) : (
            <div className="mt-1.5">{rows(view.switches)}</div>
          )}
        </div>
        <div className="min-w-0 border-t border-border pt-5 md:border-l md:border-t-0 md:pl-9 md:pt-0">
          <div className="flex items-center gap-3">
            <h3 className="mr-auto text-[13.5px] font-semibold tracking-tight">Sensitive-data filter</h3>
            <em className={cn("text-[11.5px] not-italic", view.filter.on ? "text-muted" : "text-faint")}>{view.filter.on ? "On" : "Off"}</em>
            <ControlSwitch feature={view.filter.feature} projectId={view.projectId} service={null} on={view.filter.on} disabled={!view.canManage || view.filter.lockedOff} label="Sensitive-data filter" />
          </div>
          <p className="mt-2 text-[12.5px] leading-normal text-muted">
            Applied where your logs start, before anything is sent to backwork. What it finds is replaced with <span className="font-mono">[filtered]</span>.
          </p>
          <div className="mt-3.5 text-2xs uppercase tracking-wide text-faint">Built in</div>
          <div className="mt-[7px] flex flex-wrap items-center gap-1.5">
            {builtIn.map((p) => <PatternChip key={p.name} p={p} canManage={view.canManage} />)}
          </div>
          <div className="mt-3.5 text-2xs uppercase tracking-wide text-faint">Yours</div>
          <div className="mt-[7px] flex flex-wrap items-center gap-1.5">
            {own.map((p) => <PatternChip key={p.name} p={p} canManage={view.canManage} />)}
            {view.canManage ? <AddPattern /> : own.length ? null : <span className="text-xs text-faint">None yet.</span>}
          </div>
          <div className="mt-3.5 overflow-hidden rounded-lg border border-border bg-bg px-3 py-2 font-mono text-[11.5px] leading-[1.8]">
            <div className="break-words"><span className="inline-block w-[54px] text-faint">before</span>{view.example.before}</div>
            <div className="break-words"><span className="inline-block w-[54px] text-faint">saved</span>{view.example.saved}</div>
          </div>
        </div>
      </div>

      {view.projectId !== null ? (
        <>
          <h3 className="mt-5 text-[13.5px] font-semibold tracking-tight">By service</h3>
          {view.services.length === 0 ? (
            <p className="mt-2 text-xs text-muted">No services have sent anything for this project in the last 7 days.</p>
          ) : (
            <div className="mt-2 overflow-x-auto scroll-thin rounded-lg border border-border bg-bg">
              <table className="w-full border-separate border-spacing-0 text-[13px]">
                <thead>
                  <tr>
                    <th className="whitespace-nowrap border-b border-border px-3 py-2 text-left text-2xs font-medium uppercase tracking-wide text-faint">Service</th>
                    {view.services[0].cells.map((c) => (
                      <th key={c.feature} className="whitespace-nowrap border-b border-border px-3 py-2 text-center text-2xs font-medium uppercase tracking-wide text-faint">{gridHeads[c.feature]}</th>
                    ))}
                  </tr>
                </thead>
                <tbody className="[&>tr:last-child>td]:border-b-0">
                  {view.services.map((row) => (
                    <tr key={row.service}>
                      <td className="whitespace-nowrap border-b border-border px-3 py-2 font-mono text-[12.5px] text-accent">{row.service}</td>
                      {row.cells.map((c) => (
                        <Cell key={c.feature} c={c} projectId={view.projectId as string} service={row.service} canManage={view.canManage} label={gridHeads[c.feature]} />
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      ) : null}

      <p className="mt-3.5 text-xs text-muted">
        {view.canManage ? "Changes take effect within a minute and are written to the audit log." : "Only owners and admins can change these."}
        {view.lastChange ? <> Last change: {view.lastChange}</> : null}
      </p>
    </div>
  );
}
