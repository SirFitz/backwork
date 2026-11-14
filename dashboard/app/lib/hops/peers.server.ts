// peer_services storage (design 9, phase 4): read the peers known to answer, save new pairs.
// The service map (BAC-76) adds a bulk read and `learnPeers`, a periodic scan of recent records
// that fills the table without anyone having opened a request.
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db, ensureSchema } from "~/db/index.server";
import { peerServices } from "~/db/schema";
import { cached, cachedStale, invalidate } from "~/lib/cache.server";
import * as loki from "~/lib/loki.server";
import { parseHopRecord } from "~/lib/hops/parse";
import { peerPairs, type PeerPair } from "~/lib/hops/peers";
import type { HopRecord } from "~/lib/hops/types";
import type { Tenant } from "~/lib/tenant.server";

/** A pair already saved in this process within this long is not written again. */
const REWRITE_AFTER_MS = 10 * 60_000;
const written = new Map<string, number>();

export interface PeerStore {
  /** Of `peers`, the ones some service of the organisation has answered as. */
  known(orgId: string, peers: readonly string[]): Promise<Set<string>>;
  save(orgId: string, pairs: readonly PeerPair[]): Promise<void>;
  /** Every saved pair of the organisation, most recently seen first (at most `PEER_READ_LIMIT`). */
  all(orgId: string): Promise<PeerPair[]>;
}

/** Most pairs read at once for the service map. */
export const PEER_READ_LIMIT = 5000;

export const peerStore: PeerStore = {
  async known(orgId, peers) {
    if (!peers.length) return new Set();
    const key = `peers:${orgId}:${[...peers].sort().join(",")}`;
    return cached(key, 30_000, async () => {
      await ensureSchema();
      const rows = await db
        .selectDistinct({ peer: peerServices.peer })
        .from(peerServices)
        .where(and(eq(peerServices.orgId, orgId), inArray(peerServices.peer, [...peers])));
      return new Set(rows.map((r) => r.peer));
    });
  },
  async save(orgId, pairs) {
    const now = Date.now();
    const fresh = pairs.filter((p) => now - (written.get(`${orgId}\u0000${p.peer}\u0000${p.service}`) ?? 0) > REWRITE_AFTER_MS);
    if (!fresh.length) return;
    await ensureSchema();
    await db
      .insert(peerServices)
      .values(fresh.map((p) => ({ orgId, peer: p.peer.slice(0, 200), service: p.service.slice(0, 200) })))
      .onConflictDoUpdate({ target: [peerServices.orgId, peerServices.peer, peerServices.service], set: { lastSeen: sql`now()` } });
    for (const p of fresh) written.set(`${orgId}\u0000${p.peer}\u0000${p.service}`, now);
  },
  async all(orgId) {
    await ensureSchema();
    return db
      .select({ peer: peerServices.peer, service: peerServices.service })
      .from(peerServices)
      .where(eq(peerServices.orgId, orgId))
      .orderBy(desc(peerServices.lastSeen), peerServices.peer, peerServices.service)
      .limit(PEER_READ_LIMIT);
  },
};

/** How long the bulk peer read is reused, in milliseconds. */
export const PEER_MAP_TTL_MS = 30_000;
const peerMapKey = (orgId: string): string => `peers-all:${orgId}`;

/** Peer host or queue name to the service that answered it. When one peer was answered by more
 *  than one service, the most recently seen wins. */
export function peerServicesFor(orgId: string, store: PeerStore = peerStore): Promise<Map<string, string>> {
  return cached(peerMapKey(orgId), PEER_MAP_TTL_MS, async () => {
    const map = new Map<string, string>();
    for (const p of await store.all(orgId)) if (!map.has(p.peer)) map.set(p.peer, p.service);
    return map;
  });
}

// ---------------------------------------------------------------- learning pairs from records

/** `learnPeers` scans at most once per this long per organisation, in milliseconds. */
export const LEARN_EVERY_MS = 5 * 60_000;
/** A scan older than this is no longer served while the next one runs, in milliseconds. */
export const LEARN_MAX_STALE_MS = 60 * 60_000;
/** How far back a scan reads, in milliseconds. */
export const LEARN_WINDOW_MS = 15 * 60_000;
/** Lines read per scan (newest first). */
export const LEARN_RECORD_LIMIT = 3000;

/** Inbound records and outbound calls that are not to a database or cache: the two halves a pair
 *  is linked from (an outbound hop whose id an inbound hop names as its parent). */
export const LEARN_RECORDS_QUERY = `{kind="hop"} |~ "\\\\bhop\\\\W{1,6}(?:in|out)(?:_end)?(?:\\\\\\\\?\\"|\\\\s|$)" !~ "\\\\bvia\\\\W{1,6}(?:db|cache)(?:\\\\\\\\?\\"|\\\\s|$)"`;

export type LearnQueryFn = (query: string, opts: { start: number; end: number; limit: number }, tenant: Tenant) => Promise<loki.LogEntry[]>;

export interface LearnResult {
  /** Records read. */
  records: number;
  /** Pairs linked in them. */
  pairs: number;
  /** Pairs not saved before, written now. */
  saved: number;
  /** The read hit `LEARN_RECORD_LIMIT` (older records were not seen). */
  truncated: boolean;
}

/** One scan: read recent records, link pairs, save the ones not already stored. */
export async function scanPeers(tenant: Tenant, read: LearnQueryFn = loki.queryRange, store: PeerStore = peerStore, now: number = Date.now()): Promise<LearnResult> {
  const entries = await read(LEARN_RECORDS_QUERY, { start: now - LEARN_WINDOW_MS, end: now, limit: LEARN_RECORD_LIMIT }, tenant);
  const records: HopRecord[] = [];
  for (const e of entries) {
    const r = parseHopRecord({ ts: e.ts, line: e.line, labels: e.labels });
    if (r) records.push(r);
  }
  const pairs = peerPairs(records);
  const stored = await store.all(tenant.orgId);
  const have = new Set(stored.map((p) => `${p.peer}\u0000${p.service}`));
  const fresh = pairs.filter((p) => !have.has(`${p.peer}\u0000${p.service}`));
  if (fresh.length) {
    await store.save(tenant.orgId, fresh);
    invalidate(peerMapKey(tenant.orgId));
  }
  return { records: records.length, pairs: pairs.length, saved: fresh.length, truncated: entries.length >= LEARN_RECORD_LIMIT };
}

/** Learn peer-to-service pairs from recent records, at most once per `LEARN_EVERY_MS` per
 *  organisation: a recent scan's result is returned as is, an older one at once while the next
 *  scan runs in the background. Only the first call for an organisation waits. */
export function learnPeers(tenant: Tenant, read: LearnQueryFn = loki.queryRange, store: PeerStore = peerStore, now: () => number = Date.now): Promise<LearnResult> {
  return cachedStale(`peers-learn:${tenant.orgId}`, LEARN_EVERY_MS, LEARN_MAX_STALE_MS, () => scanPeers(tenant, read, store, now()), now);
}

/** Known peers among the ones these records call, after saving the pairs they link. Never throws:
 *  null means "could not tell", and callers then keep the design's default (a gap). */
export async function knownPeersFor(
  orgId: string,
  pairs: readonly PeerPair[],
  called: readonly string[],
  store: PeerStore = peerStore
): Promise<string[] | null> {
  try {
    await store.save(orgId, pairs);
    const known = await store.known(orgId, called);
    for (const p of pairs) known.add(p.peer);
    return [...known].sort();
  } catch {
    return null;
  }
}
