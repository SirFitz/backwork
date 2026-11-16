/**
 * Writes derived error events (BAC-85) without ever slowing or failing ingest: a push's events
 * are grouped in memory, written in one batched upsert (plus one insert for the sampled
 * occurrences), off the request path. Failures are counted and swallowed. Per organisation,
 * new groups per minute are capped; per group, stored occurrences per minute are capped (the
 * group's count still includes every occurrence).
 *
 * The database is behind `DerivedErrorStore`, so this module has no I/O of its own.
 */
import type { DerivedError, ErrorLevel, ErrorSource } from "~/lib/errors-derive";

/** One group's share of a push. */
export interface GroupWrite {
  fingerprint: string;
  source: ErrorSource;
  title: string;
  type: string;
  service: string;
  level: ErrorLevel;
  /** Occurrences in this push (all of them, sampled or not). */
  count: number;
  firstAt: Date;
  lastAt: Date;
  /** The latest occurrence. */
  sample: OccurrencePayload;
}

/** What an occurrence stores (error_events.payload, error_groups.sample). */
export interface OccurrencePayload {
  source: ErrorSource;
  type: string;
  message: string;
  service: string;
  level: ErrorLevel;
  traceId: string | null;
  method: string | null;
  route: string | null;
  status: number | null;
  at: string;
}

export interface EventWrite {
  groupId: string;
  source: ErrorSource;
  createdAt: Date;
  payload: OccurrencePayload;
}

export interface UpsertedGroup {
  id: string;
  fingerprint: string;
  /** True when the row was created by this write. */
  inserted: boolean;
}

export interface DerivedErrorStore {
  /** Insert or update groups in one statement. */
  upsertGroups(orgId: string, project: string, groups: readonly GroupWrite[]): Promise<UpsertedGroup[]>;
  /** Update existing groups of one project only (never creates one), in one statement. */
  updateGroups(orgId: string, project: string, groups: readonly GroupWrite[]): Promise<UpsertedGroup[]>;
  insertEvents(orgId: string, events: readonly EventWrite[]): Promise<void>;
}

export interface SinkLimits {
  /** New groups an organisation may create per minute; beyond it, only existing groups are counted. */
  newGroupsPerMinute: number;
  /** Occurrences stored per group per minute; beyond it they only add to the group's count. */
  eventsPerGroupPerMinute: number;
  /** Writes running at once; a push arriving beyond it is skipped and counted. */
  maxInFlight: number;
  /** Known fingerprints remembered per organisation (bounds memory). */
  knownPerOrg: number;
}

export const DEFAULT_SINK_LIMITS: SinkLimits = {
  newGroupsPerMinute: 30,
  eventsPerGroupPerMinute: 10,
  maxInFlight: 4,
  knownPerOrg: 5000,
};

export interface SinkStats {
  /** Pushes whose events were written. */
  writes: number;
  /** Occurrences counted on a group. */
  counted: number;
  /** Occurrences stored as events. */
  stored: number;
  /** Occurrences counted but not stored (per-group cap). */
  sampled: number;
  /** Occurrences of new groups not created (new-group cap). */
  droppedNewGroup: number;
  /** Pushes skipped because too many writes were running. */
  skippedBusy: number;
  /** Writes that threw. */
  failed: number;
}

export interface FlushResult {
  groups: number;
  created: number;
  stored: number;
  sampled: number;
  droppedNewGroup: number;
}

const MINUTE = 60_000;

function payloadOf(e: DerivedError): OccurrencePayload {
  return {
    source: e.source, type: e.type, message: e.message, service: e.service, level: e.level,
    traceId: e.traceId, method: e.method, route: e.route, status: e.status, at: new Date(e.at).toISOString(),
  };
}

/** Group a push's events by fingerprint, keeping order of first appearance. */
export function groupEvents(errors: readonly DerivedError[]): Map<string, { group: GroupWrite; events: DerivedError[] }> {
  const out = new Map<string, { group: GroupWrite; events: DerivedError[] }>();
  for (const e of errors) {
    const at = new Date(e.at);
    const g = out.get(e.fingerprint);
    if (!g) {
      out.set(e.fingerprint, {
        group: { fingerprint: e.fingerprint, source: e.source, title: e.title, type: e.type, service: e.service, level: e.level, count: 1, firstAt: at, lastAt: at, sample: payloadOf(e) },
        events: [e],
      });
      continue;
    }
    g.group.count++;
    if (at < g.group.firstAt) g.group.firstAt = at;
    if (at >= g.group.lastAt) {
      g.group.lastAt = at;
      g.group.sample = payloadOf(e);
      g.group.title = e.title;
      g.group.type = e.type;
    }
    g.events.push(e);
  }
  return out;
}

export class DerivedErrorSink {
  readonly stats: SinkStats = { writes: 0, counted: 0, stored: 0, sampled: 0, droppedNewGroup: 0, skippedBusy: 0, failed: 0 };
  private inFlight = 0;
  private minute = -1;
  private newGroups = new Map<string, number>();
  private eventsByGroup = new Map<string, number>();
  private known = new Map<string, Set<string>>();
  private lastWarn = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly store: DerivedErrorStore,
    private readonly limits: SinkLimits = DEFAULT_SINK_LIMITS,
    private readonly now: () => number = Date.now,
    private readonly warn: (msg: string) => void = (m) => console.warn(m),
  ) {}

  /** Fire and forget from the ingest path: never throws, never awaited. */
  submit(orgId: string, project: string, errors: readonly DerivedError[]): void {
    if (errors.length === 0) return;
    if (this.inFlight >= this.limits.maxInFlight) {
      this.stats.skippedBusy++;
      return;
    }
    this.inFlight++;
    this.flush(orgId, project, errors)
      .catch((e: unknown) => {
        this.stats.failed++;
        const t = this.now();
        if (t - this.lastWarn > MINUTE) {
          this.lastWarn = t;
          this.warn(`[derived-errors] write failed (${this.stats.failed} so far): ${e instanceof Error ? e.message : String(e)}`);
        }
      })
      .finally(() => {
        this.inFlight--;
      });
  }

  /** Write one push's events. Throws when the store throws (submit swallows it). */
  async flush(orgId: string, project: string, errors: readonly DerivedError[]): Promise<FlushResult> {
    this.roll();
    const grouped = groupEvents(errors);
    // Groups are per project (BAC-89): the same error in dev and production is two groups.
    const scope = `${orgId}\u0000${project}`;
    const known = this.knownOf(scope);
    const used = this.newGroups.get(orgId) ?? 0;
    let allowance = Math.max(0, this.limits.newGroupsPerMinute - used);
    const mayCreate: GroupWrite[] = [];
    const updateOnly: GroupWrite[] = [];
    for (const { group } of grouped.values()) {
      if (known.has(group.fingerprint)) mayCreate.push(group);
      else if (allowance > 0) {
        allowance--;
        mayCreate.push(group);
      } else updateOnly.push(group);
    }

    const written: UpsertedGroup[] = [];
    if (mayCreate.length) written.push(...(await this.store.upsertGroups(orgId, project, mayCreate)));
    if (updateOnly.length) written.push(...(await this.store.updateGroups(orgId, project, updateOnly)));

    let created = 0;
    for (const w of written) {
      if (w.inserted) created++;
      this.remember(scope, w.fingerprint);
    }
    this.newGroups.set(orgId, used + created);

    const idOf = new Map(written.map((w) => [w.fingerprint, w.id]));
    const events: EventWrite[] = [];
    let sampled = 0;
    let dropped = 0;
    let counted = 0;
    for (const [fp, { events: occ }] of grouped) {
      const groupId = idOf.get(fp);
      if (!groupId) {
        dropped += occ.length;
        continue;
      }
      counted += occ.length;
      const key = `${scope}|${fp}`;
      const already = this.eventsByGroup.get(key) ?? 0;
      const room = Math.max(0, this.limits.eventsPerGroupPerMinute - already);
      // keep the newest occurrences when sampling
      const keep = occ.length <= room ? occ : occ.slice(occ.length - room);
      this.eventsByGroup.set(key, already + keep.length);
      sampled += occ.length - keep.length;
      for (const e of keep) events.push({ groupId, source: e.source, createdAt: new Date(e.at), payload: payloadOf(e) });
    }
    if (events.length) await this.store.insertEvents(orgId, events);

    this.stats.writes++;
    this.stats.counted += counted;
    this.stats.stored += events.length;
    this.stats.sampled += sampled;
    this.stats.droppedNewGroup += dropped;
    return { groups: written.length, created, stored: events.length, sampled, droppedNewGroup: dropped };
  }

  /** Writes running now (tests). */
  get running(): number {
    return this.inFlight;
  }

  private roll(): void {
    const m = Math.floor(this.now() / MINUTE);
    if (m === this.minute) return;
    this.minute = m;
    this.newGroups.clear();
    this.eventsByGroup.clear();
  }

  /** Fingerprints known to exist for one organisation + project scope. */
  private knownOf(scope: string): Set<string> {
    let s = this.known.get(scope);
    if (!s) {
      s = new Set();
      this.known.set(scope, s);
    }
    return s;
  }

  private remember(scope: string, fp: string): void {
    const s = this.knownOf(scope);
    if (s.size >= this.limits.knownPerOrg) s.clear();
    s.add(fp);
  }
}
