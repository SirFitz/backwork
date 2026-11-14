// Pinned requests (BAC-78): a copy of a request's hop records, log lines and links in Postgres, so
// it can still be opened after Loki's retention (or the plan trim) has removed it. Read and write
// of `pinned_requests` and `pin_settings`, the request view's pin action, and the loader fallback.
// The rules (caps, trimming, which copy to show) are pure, in `pins.ts`.
import { json } from "@remix-run/node";
import { and, desc, eq, lt, or, sql } from "drizzle-orm";
import { db, ensureSchema } from "~/db/index.server";
import { orgs, pinSettings, pinnedRequests, users } from "~/db/schema";
import { hasRole, requireOrg, type OrgContext } from "~/lib/auth/context.server";
import { assertSameOrigin } from "~/lib/auth/security.server";
import { logAudit } from "~/lib/audit.server";
import { tenantOf } from "~/lib/tenant.server";
import { orgLimits } from "~/lib/plans/usage.server";
import { logLinesFor, progressiveLookup, type HopQueryFn, type ProgressiveLookup, type WindowResult } from "~/lib/hops/query.server";
import { isTraceId } from "~/lib/hops/parse";
import { SearchWindow, type HopRecord, type LinkedId, type TraceId, type TraceLogLine } from "~/lib/hops/types";
import type { RequestSummary } from "~/lib/hops/tree";
import {
  PIN_FORMAT_VERSION,
  PinIntent,
  PinReason,
  SlotKind,
  cleanNote,
  describeSnapshot,
  isPinReason,
  pinLimitFor,
  pinSlot,
  pinnedCopyWanted,
  pinCursor,
  planLabel,
  trimSnapshot,
  type PinCursor,
  type AutoPinSettings,
  type PinActionData,
  type PinPage,
  type PinSnapshot,
  type PinnedCopyInfo,
  type PinnedRequest,
} from "./pins";

export { PinIntent, PinReason, type PinPage, type PinSnapshot, type PinnedRequest };

/** Audit names for pins (C-platform section 7: each feature owns its own). */
export const PinAudit = {
  Add: "pin.add",
  Remove: "pin.remove",
  Auto: "pin.auto",
  Settings: "pin.settings",
} as const;
export type PinAudit = (typeof PinAudit)[keyof typeof PinAudit];

/** Who pins: a person, or the auto-pin job (no user). */
export interface PinActor {
  orgId: string;
  userId: string | null;
}

export type PinResult =
  | { ok: true; created: boolean; trimmed: boolean; bytes: number; evicted: string | null }
  | { ok: false; error: string };

/** The `records` column: the parsed records plus what the list reads without loading them. */
interface StoredEnvelope {
  v: number;
  summary: RequestSummary | null;
  trimmed: boolean;
  truncated: boolean;
  records: HopRecord[];
}

// ---------------------------------------------------------------- reading the untyped jsonb edge

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isHopRecordLike(v: unknown): v is HopRecord {
  return isObject(v) && typeof v.traceId === "string" && typeof v.hopId === "string" && typeof v.hop === "string" && typeof v.timeMs === "number";
}

function isLineLike(v: unknown): v is TraceLogLine {
  return isObject(v) && typeof v.line === "string" && typeof v.timeMs === "number" && typeof v.service === "string";
}

function isLinkLike(v: unknown): v is LinkedId {
  return isObject(v) && typeof v.name === "string" && typeof v.value === "string" && typeof v.timeMs === "number";
}

function envelopeOf(raw: unknown): StoredEnvelope {
  if (Array.isArray(raw)) return { v: 0, summary: null, trimmed: false, truncated: false, records: raw.filter(isHopRecordLike) };
  if (!isObject(raw)) return { v: 0, summary: null, trimmed: false, truncated: false, records: [] };
  const records = Array.isArray(raw.records) ? raw.records.filter(isHopRecordLike) : [];
  return {
    v: typeof raw.v === "number" ? raw.v : 0,
    summary: isObject(raw.summary) ? (raw.summary as unknown as RequestSummary) : null,
    trimmed: raw.trimmed === true,
    truncated: raw.truncated === true,
    records,
  };
}

function summaryOf(raw: unknown): RequestSummary | null {
  return isObject(raw) ? (raw as unknown as RequestSummary) : null;
}

const metaColumns = {
  traceId: pinnedRequests.traceId,
  title: pinnedRequests.title,
  note: pinnedRequests.note,
  reason: pinnedRequests.reason,
  bytes: pinnedRequests.bytes,
  pinnedAt: pinnedRequests.pinnedAt,
  pinnedBy: pinnedRequests.pinnedBy,
  pinnedByName: users.name,
  summary: sql<unknown>`${pinnedRequests.records} -> 'summary'`,
  trimmed: sql<boolean | null>`(${pinnedRequests.records} ->> 'trimmed')::boolean`,
  truncated: sql<boolean | null>`(${pinnedRequests.records} ->> 'truncated')::boolean`,
};

interface MetaRow {
  traceId: string;
  title: string;
  note: string | null;
  reason: string;
  bytes: number;
  pinnedAt: Date;
  pinnedBy: string | null;
  pinnedByName: string | null;
  summary: unknown;
  trimmed: boolean | null;
  truncated: boolean | null;
}

function toPinned(r: MetaRow): PinnedRequest {
  return {
    traceId: r.traceId,
    title: r.title,
    note: r.note,
    reason: isPinReason(r.reason) ? r.reason : PinReason.Manual,
    bytes: r.bytes,
    pinnedAt: r.pinnedAt.getTime(),
    pinnedBy: r.pinnedBy,
    pinnedByName: r.pinnedByName || null,
    summary: summaryOf(r.summary),
    trimmed: r.trimmed === true,
    truncated: r.truncated === true,
  };
}

// ---------------------------------------------------------------- write

/**
 * Store a snapshot (already fetched from the server's own lookup, never from the browser). Pinning
 * a pinned request updates its note (a manual pin also makes it manual, so it is never evicted).
 * The cap check and the insert run under a lock on the organisation row, so two pins at once
 * cannot both take the last slot.
 */
export async function pinRequest(
  actor: PinActor,
  traceId: string,
  snap: PinSnapshot & { truncated?: boolean },
  o: { reason: PinReason; note?: string | null; title?: string },
  now: number = Date.now(),
): Promise<PinResult> {
  await ensureSchema();
  const note = cleanNote(o.note ?? null);
  return db.transaction(async (tx): Promise<PinResult> => {
    const org = await tx.select({ plan: orgs.plan }).from(orgs).where(eq(orgs.id, actor.orgId)).for("update");
    if (!org.length) return { ok: false, error: "Organisation not found." };
    const pins = await tx
      .select({ traceId: pinnedRequests.traceId, reason: pinnedRequests.reason, pinnedAt: pinnedRequests.pinnedAt })
      .from(pinnedRequests)
      .where(eq(pinnedRequests.orgId, actor.orgId));
    const slot = pinSlot(
      traceId,
      o.reason,
      org[0].plan,
      pins.map((p) => ({ traceId: p.traceId, reason: isPinReason(p.reason) ? p.reason : PinReason.Manual, pinnedAt: p.pinnedAt.getTime() })),
    );
    if (slot.kind === SlotKind.Refuse) return { ok: false, error: slot.message };
    if (slot.kind === SlotKind.Update) {
      const set: { note: string | null; reason?: PinReason } = { note };
      if (o.reason === PinReason.Manual) set.reason = PinReason.Manual;
      await tx.update(pinnedRequests).set(set).where(and(eq(pinnedRequests.orgId, actor.orgId), eq(pinnedRequests.traceId, traceId)));
      return { ok: true, created: false, trimmed: false, bytes: 0, evicted: null };
    }
    if (!snap.records.length && !snap.links.length) return { ok: false, error: "This request's records are no longer stored, so it cannot be pinned." };
    let evicted: string | null = null;
    if (slot.kind === SlotKind.Evict) {
      await tx.delete(pinnedRequests).where(and(eq(pinnedRequests.orgId, actor.orgId), eq(pinnedRequests.traceId, slot.traceId)));
      evicted = slot.traceId;
    }
    const fit = trimSnapshot({ records: snap.records, lines: snap.lines, links: snap.links });
    const described = describeSnapshot(fit.snapshot, now);
    const envelope: StoredEnvelope = {
      v: PIN_FORMAT_VERSION,
      summary: described.summary,
      trimmed: fit.trimmed,
      truncated: snap.truncated === true,
      records: fit.snapshot.records,
    };
    await tx.insert(pinnedRequests).values({
      orgId: actor.orgId,
      traceId,
      title: (o.title ?? described.title).slice(0, 200),
      note,
      reason: o.reason,
      records: envelope as unknown as Record<string, unknown>,
      lines: fit.snapshot.lines as unknown as Record<string, unknown>[],
      links: fit.snapshot.links as unknown as Record<string, unknown>[],
      bytes: fit.bytes,
      pinnedBy: actor.userId,
      pinnedAt: new Date(now),
    });
    return { ok: true, created: true, trimmed: fit.trimmed, bytes: fit.bytes, evicted };
  });
}

/** Remove a pin. True when there was one. */
export async function unpinRequest(orgId: string, traceId: string): Promise<boolean> {
  await ensureSchema();
  const gone = await db
    .delete(pinnedRequests)
    .where(and(eq(pinnedRequests.orgId, orgId), eq(pinnedRequests.traceId, traceId)))
    .returning({ traceId: pinnedRequests.traceId });
  return gone.length > 0;
}

// ---------------------------------------------------------------- read

/** A pin without its snapshot (cheap: the request view asks on every load). */
export async function pinMeta(orgId: string, traceId: string): Promise<PinnedRequest | null> {
  await ensureSchema();
  const rows = await db
    .select(metaColumns)
    .from(pinnedRequests)
    .leftJoin(users, eq(users.id, pinnedRequests.pinnedBy))
    .where(and(eq(pinnedRequests.orgId, orgId), eq(pinnedRequests.traceId, traceId)))
    .limit(1);
  return rows[0] ? toPinned(rows[0]) : null;
}

/** A pin with its snapshot. */
export async function loadPin(orgId: string, traceId: string): Promise<(PinnedRequest & PinSnapshot) | null> {
  await ensureSchema();
  const rows = await db
    .select({ ...metaColumns, records: pinnedRequests.records, lines: pinnedRequests.lines, links: pinnedRequests.links })
    .from(pinnedRequests)
    .leftJoin(users, eq(users.id, pinnedRequests.pinnedBy))
    .where(and(eq(pinnedRequests.orgId, orgId), eq(pinnedRequests.traceId, traceId)))
    .limit(1);
  const r = rows[0];
  if (!r) return null;
  const env = envelopeOf(r.records);
  const lines = Array.isArray(r.lines) ? (r.lines as unknown[]).filter(isLineLike) : [];
  const links = Array.isArray(r.links) ? (r.links as unknown[]).filter(isLinkLike) : [];
  return { ...toPinned(r), records: env.records, lines, links };
}

/** Newest first; `before` continues after the last pin of an earlier page. */
export async function listPins(orgId: string, limit: number, before?: PinCursor | null): Promise<PinnedRequest[]> {
  await ensureSchema();
  const where = before
    ? and(
        eq(pinnedRequests.orgId, orgId),
        or(
          lt(pinnedRequests.pinnedAt, new Date(before.pinnedAt)),
          and(eq(pinnedRequests.pinnedAt, new Date(before.pinnedAt)), lt(pinnedRequests.traceId, before.traceId)),
        ),
      )
    : eq(pinnedRequests.orgId, orgId);
  const rows = await db
    .select(metaColumns)
    .from(pinnedRequests)
    .leftJoin(users, eq(users.id, pinnedRequests.pinnedBy))
    .where(where)
    .orderBy(desc(pinnedRequests.pinnedAt), desc(pinnedRequests.traceId))
    .limit(limit);
  return rows.map(toPinned);
}

/** Rows per page of the Pinned list. */
export const PIN_PAGE_SIZE = 50;

export async function listPinsPage(orgId: string, before?: PinCursor | null, limit: number = PIN_PAGE_SIZE): Promise<PinPage> {
  const rows = await listPins(orgId, limit + 1, before);
  const page = rows.slice(0, limit);
  return { rows: page, next: rows.length > limit ? pinCursor(page[page.length - 1]) : null };
}

export interface PinUsage {
  count: number;
  limit: number;
  /** "Free"; null for an unmetered organisation. */
  plan: string | null;
}

export async function pinUsage(orgId: string): Promise<PinUsage> {
  await ensureSchema();
  const [org] = await db.select({ plan: orgs.plan }).from(orgs).where(eq(orgs.id, orgId)).limit(1);
  const [c] = await db.select({ n: sql<number>`count(*)::int` }).from(pinnedRequests).where(eq(pinnedRequests.orgId, orgId));
  const plan = org?.plan ?? "free";
  return { count: c?.n ?? 0, limit: pinLimitFor(plan), plan: planLabel(plan) };
}

// ---------------------------------------------------------------- automatic pin settings

export async function loadPinSettings(orgId: string): Promise<AutoPinSettings> {
  await ensureSchema();
  const [r] = await db.select({ slow: pinSettings.autoSlow, failed: pinSettings.autoFailed }).from(pinSettings).where(eq(pinSettings.orgId, orgId)).limit(1);
  return { slow: r?.slow ?? false, failed: r?.failed ?? false };
}

export async function savePinSettings(orgId: string, userId: string | null, s: AutoPinSettings): Promise<void> {
  await ensureSchema();
  await db
    .insert(pinSettings)
    .values({ orgId, autoSlow: s.slow, autoFailed: s.failed, updatedBy: userId, updatedAt: new Date() })
    .onConflictDoUpdate({ target: pinSettings.orgId, set: { autoSlow: s.slow, autoFailed: s.failed, updatedBy: userId, updatedAt: new Date() } });
}

/** Organisations with any automatic pinning switched on. */
export async function orgsWithAutoPins(): Promise<Array<{ orgId: string } & AutoPinSettings>> {
  await ensureSchema();
  const rows = await db
    .select({ orgId: pinSettings.orgId, slow: pinSettings.autoSlow, failed: pinSettings.autoFailed })
    .from(pinSettings)
    .where(or(eq(pinSettings.autoSlow, true), eq(pinSettings.autoFailed, true)));
  return rows;
}

// ---------------------------------------------------------------- the server's own copy of a request

/** Records, lines and links of a request as the request view would fetch them; null when Loki has none. */
export async function fetchSnapshot(traceId: TraceId, orgId: string, now: number = Date.now(), query?: HopQueryFn): Promise<(PinSnapshot & { truncated: boolean }) | null> {
  const tenant = tenantOf(orgId);
  const found = await progressiveLookup(traceId, tenant, now, query).retention;
  if (!found.found) return null;
  const lines = await logLinesFor(traceId, found, tenant, now, query);
  return { records: found.records, links: found.links, lines, truncated: found.truncated };
}

// ---------------------------------------------------------------- the request view's action

export interface PinActionDeps {
  context: (request: Request) => Promise<OrgContext>;
  snapshot: (traceId: TraceId, orgId: string, now: number) => Promise<(PinSnapshot & { truncated: boolean }) | null>;
  pin: typeof pinRequest;
  unpin: typeof unpinRequest;
  isPinned: (orgId: string, traceId: string) => Promise<boolean>;
  audit: typeof logAudit;
  now: () => number;
}

const DEFAULT_ACTION_DEPS: PinActionDeps = {
  context: requireOrg,
  snapshot: (traceId, orgId, now) => fetchSnapshot(traceId, orgId, now),
  pin: pinRequest,
  unpin: unpinRequest,
  isPinned: async (orgId, traceId) => (await pinMeta(orgId, traceId)) !== null,
  audit: logAudit,
  now: Date.now,
};

function answer(data: PinActionData, status = 200): Response {
  return json(data, { status });
}

/**
 * `pin` / `unpin` from the request view. Same origin, member role and above. The snapshot is the
 * server's own lookup of the trace ID: nothing in the form but the intent and the note is read.
 */
export async function pinAction(request: Request, traceId: TraceId | null, deps: PinActionDeps = DEFAULT_ACTION_DEPS): Promise<Response> {
  assertSameOrigin(request);
  const ctx = await deps.context(request);
  if (!hasRole(ctx.role, "member")) return answer({ ok: false, error: "Viewers cannot pin requests." }, 403);
  if (!traceId || !isTraceId(traceId)) return answer({ ok: false, error: "Not a trace ID." }, 400);
  const fd = await request.formData();
  const intent = String(fd.get("intent") ?? "");
  const orgId = ctx.org.id;
  if (intent === PinIntent.Unpin) {
    const removed = await deps.unpin(orgId, traceId);
    if (removed) void deps.audit({ request, orgId, actorUserId: ctx.user.id, action: PinAudit.Remove, target: { traceId } });
    return answer({ ok: true, intent: PinIntent.Unpin, trimmed: false });
  }
  if (intent !== PinIntent.Pin) return answer({ ok: false, error: "Unknown action." }, 400);
  const note = cleanNote(fd.get("note"));
  const now = deps.now();
  const snap = await deps.snapshot(traceId, orgId, now);
  if (!snap) {
    // Already pinned and expired from Loki: the stored copy stays; only the note changes.
    if (await deps.isPinned(orgId, traceId)) {
      const r = await deps.pin({ orgId, userId: ctx.user.id }, traceId, { records: [], lines: [], links: [] }, { reason: PinReason.Manual, note }, now);
      return r.ok ? answer({ ok: true, intent: PinIntent.Pin, trimmed: false }) : answer({ ok: false, error: r.error }, 409);
    }
    return answer({ ok: false, error: "This request's records are no longer stored, so it cannot be pinned." }, 404);
  }
  const r = await deps.pin({ orgId, userId: ctx.user.id }, traceId, snap, { reason: PinReason.Manual, note }, now);
  if (!r.ok) return answer({ ok: false, error: r.error }, 409);
  void deps.audit({ request, orgId, actorUserId: ctx.user.id, action: PinAudit.Add, target: { traceId, reason: PinReason.Manual, created: r.created, trimmed: r.trimmed } });
  return answer({ ok: true, intent: PinIntent.Pin, trimmed: r.trimmed });
}

// ---------------------------------------------------------------- the request view's loader fallback

/** One search window's answer, with the pin (if any) and, when shown instead, the pinned copy. */
export interface PinnedLookupResult {
  result: WindowResult;
  pin: PinnedRequest | null;
  /** Set when the result is the pinned copy rather than the live records. */
  copy: PinnedCopyInfo | null;
  /** The pinned copy's log lines; null for live records (their lines come from Loki). */
  lines: TraceLogLine[] | null;
}

export interface PinnedLookup {
  hour: Promise<PinnedLookupResult>;
  day: Promise<PinnedLookupResult>;
  retention: Promise<PinnedLookupResult>;
}

export interface PinFallbackDeps {
  meta: (orgId: string, traceId: string) => Promise<PinnedRequest | null>;
  load: (orgId: string, traceId: string) => Promise<(PinnedRequest & PinSnapshot) | null>;
  hopDays: (orgId: string) => Promise<number | null>;
}

const DEFAULT_FALLBACK_DEPS: PinFallbackDeps = {
  meta: pinMeta,
  load: loadPin,
  hopDays: async (orgId) => (await orgLimits(orgId))?.hopDays ?? null,
};

/**
 * Loki first; the pinned copy when Loki has nothing (after the last window) or only records older
 * than the plan keeps. A pin lookup that fails never breaks the live view: it counts as no pin.
 */
export function withPinFallback(
  lookup: ProgressiveLookup,
  orgId: string,
  traceId: TraceId,
  now: number,
  deps: PinFallbackDeps = DEFAULT_FALLBACK_DEPS,
): PinnedLookup {
  const meta = deps.meta(orgId, traceId).catch(() => null);
  const hopDays = deps.hopDays(orgId).catch(() => null);
  let full: Promise<(PinnedRequest & PinSnapshot) | null> | null = null;
  const loadOnce = (): Promise<(PinnedRequest & PinSnapshot) | null> => (full ??= deps.load(orgId, traceId).catch(() => null));

  const level = (p: Promise<WindowResult>, last: boolean): Promise<PinnedLookupResult> =>
    p.then(async (r): Promise<PinnedLookupResult> => {
      const pin = await meta;
      const live: PinnedLookupResult = { result: r, pin, copy: null, lines: null };
      if (!r.found && !last) return live;
      const earliestMs = r.records.length ? Math.min(...r.records.map((x) => x.timeMs)) : null;
      if (!pinnedCopyWanted({ found: r.found, earliestMs }, pin !== null, await hopDays, now)) return live;
      const copy = await loadOnce();
      if (!copy || (!copy.records.length && !copy.links.length)) return live;
      const env = pin ?? copy;
      return {
        result: { window: SearchWindow.Retention, found: true, records: copy.records, links: copy.links, searchedFromMs: r.searchedFromMs, truncated: env.truncated },
        pin: env,
        copy: { pinnedAt: env.pinnedAt, reason: env.reason, note: env.note, trimmed: env.trimmed },
        lines: copy.lines,
      };
    });

  return { hour: level(lookup.hour, false), day: level(lookup.day, false), retention: level(lookup.retention, true) };
}
