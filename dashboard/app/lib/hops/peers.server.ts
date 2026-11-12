// peer_services storage (design 9, phase 4): read the peers known to answer, save new pairs.
import { and, eq, inArray, sql } from "drizzle-orm";
import { db, ensureSchema } from "~/db/index.server";
import { peerServices } from "~/db/schema";
import { cached } from "~/lib/cache.server";
import type { PeerPair } from "~/lib/hops/peers";

/** A pair already saved in this process within this long is not written again. */
const REWRITE_AFTER_MS = 10 * 60_000;
const written = new Map<string, number>();

export interface PeerStore {
  /** Of `peers`, the ones some service of the organisation has answered as. */
  known(orgId: string, peers: readonly string[]): Promise<Set<string>>;
  save(orgId: string, pairs: readonly PeerPair[]): Promise<void>;
}

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
};

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
