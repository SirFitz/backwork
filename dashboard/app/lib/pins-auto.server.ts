// Automatic pins (BAC-78): once an hour, for each organisation that switched it on, keep the last
// hour's slowest request and its first failed one, through the same `pinRequest` as a manual pin.
// Which requests is decided by the pure `pickAutoPins`. The insert takes a lock on the
// organisation row and skips anything already pinned, so two processes running the job at once
// cannot pin one request twice or pass the daily limit by more than one run's picks.
import { logAudit } from "~/lib/audit.server";
import { tenantOf } from "~/lib/tenant.server";
import { hopRequestPage, type RequestListRow } from "~/lib/hops/requests.server";
import type { TraceId } from "~/lib/hops/types";
import { isTraceId } from "~/lib/hops/parse";
import { pickAutoPins, type AutoPinSettings, type PinSnapshot, type PinnedRequest } from "./pins";
import { PinAudit, fetchSnapshot, listPins, orgsWithAutoPins, pinRequest, unpinRequest, type PinResult } from "./pins.server";

/** How often the job runs, ms. */
export const AUTO_PIN_INTERVAL_MS = 60 * 60 * 1000;
/** First run after the process starts, ms (lets the process settle first). */
export const AUTO_PIN_FIRST_RUN_MS = 5 * 60 * 1000;
/** Inbound rows read per organisation per run. */
export const AUTO_PIN_SCAN_ROWS = 1000;
/** The window scanned each run, ms. */
export const AUTO_PIN_WINDOW_MS = 60 * 60 * 1000;
/** Existing pins read to check for duplicates and the daily limit (the largest plan cap). */
const EXISTING_PINS_READ = 500;

export interface AutoPinDeps {
  orgs: () => Promise<Array<{ orgId: string } & AutoPinSettings>>;
  rows: (orgId: string, now: number) => Promise<RequestListRow[]>;
  existing: (orgId: string) => Promise<PinnedRequest[]>;
  snapshot: (traceId: TraceId, orgId: string, now: number) => Promise<(PinSnapshot & { truncated: boolean }) | null>;
  pin: typeof pinRequest;
  unpin: typeof unpinRequest;
  audit: typeof logAudit;
}

const DEFAULT_DEPS: AutoPinDeps = {
  orgs: orgsWithAutoPins,
  rows: async (orgId, now) =>
    (await hopRequestPage(tenantOf(orgId), { service: null, sinceMs: now - AUTO_PIN_WINDOW_MS, before: now, limit: AUTO_PIN_SCAN_ROWS })).rows,
  existing: (orgId) => listPins(orgId, EXISTING_PINS_READ),
  snapshot: (traceId, orgId, now) => fetchSnapshot(traceId, orgId, now),
  pin: pinRequest,
  unpin: unpinRequest,
  audit: logAudit,
};

export interface AutoPinReport {
  orgId: string;
  pinned: string[];
  error: string | null;
}

/** One run over every organisation with automatic pins on. Each organisation fails alone. */
export async function runAutoPins(now: number = Date.now(), deps: AutoPinDeps = DEFAULT_DEPS): Promise<AutoPinReport[]> {
  const out: AutoPinReport[] = [];
  for (const o of await deps.orgs()) {
    const report: AutoPinReport = { orgId: o.orgId, pinned: [], error: null };
    try {
      const picks = pickAutoPins(await deps.rows(o.orgId, now), await deps.existing(o.orgId), o, now);
      for (const pick of picks) {
        if (!isTraceId(pick.traceId)) continue;
        const snap = await deps.snapshot(pick.traceId, o.orgId, now);
        if (!snap) continue;
        if (pick.replaces) await deps.unpin(o.orgId, pick.replaces);
        const r: PinResult = await deps.pin({ orgId: o.orgId, userId: null }, pick.traceId, snap, { reason: pick.reason }, now);
        if (!r.ok || !r.created) continue;
        report.pinned.push(pick.traceId);
        void deps.audit({ orgId: o.orgId, action: PinAudit.Auto, target: { traceId: pick.traceId, reason: pick.reason, replaces: pick.replaces, evicted: r.evicted } });
      }
    } catch (e: unknown) {
      report.error = e instanceof Error ? e.message.slice(0, 200) : String(e);
    }
    out.push(report);
  }
  if (out.length) console.log(JSON.stringify({ msg: "auto pins", orgs: out.length, pinned: out.reduce((n, r) => n + r.pinned.length, 0) }));
  return out;
}

declare global {
  // eslint-disable-next-line no-var
  var __bwAutoPins: boolean | undefined;
}

/** Start the hourly job once per process. */
export function startAutoPins(): void {
  if (globalThis.__bwAutoPins) return;
  globalThis.__bwAutoPins = true;
  const run = (): void => {
    runAutoPins().catch((e: unknown) => console.error(JSON.stringify({ msg: "auto pins failed", error: e instanceof Error ? e.message : String(e) })));
  };
  setTimeout(() => {
    run();
    setInterval(run, AUTO_PIN_INTERVAL_MS).unref();
  }, AUTO_PIN_FIRST_RUN_MS).unref();
}
