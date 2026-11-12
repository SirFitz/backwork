// Peer-to-service pairs (design 9, phase 4), pure. An outbound hop names its destination as a
// host or queue (`peer`); the inbound hop it reached names the service. Each such pair says the
// peer is a service that reports hop records, so a later call to it with no inbound record is a
// real gap ("No record from"), while a call to a peer never seen answering is "not instrumented
// yet" (a third party, or a service without Correlator), shown but not counted as a gap.
import { isStoreVia } from "~/lib/hops/tree";
import { HopKind, type HopId, type HopRecord } from "~/lib/hops/types";

export interface PeerPair {
  peer: string;
  service: string;
}

/** Pairs linked in these records: an outbound (non-store) hop and an inbound hop whose parent it is. */
export function peerPairs(records: readonly HopRecord[]): PeerPair[] {
  const peerOf = new Map<HopId, string>();
  for (const r of records) {
    if ((r.hop === HopKind.Out || r.hop === HopKind.OutEnd) && !isStoreVia(r.via) && r.peer) peerOf.set(r.hopId, r.peer);
  }
  const out = new Map<string, PeerPair>();
  for (const r of records) {
    if (r.hop !== HopKind.In && r.hop !== HopKind.InEnd) continue;
    const peer = r.parentHop ? peerOf.get(r.parentHop) : undefined;
    if (!peer) continue;
    out.set(`${peer}\u0000${r.service}`, { peer, service: r.service });
  }
  return [...out.values()];
}

/** Peers called by outbound (non-store) hops in these records. */
export function calledPeers(records: readonly HopRecord[]): string[] {
  const set = new Set<string>();
  for (const r of records) if ((r.hop === HopKind.Out || r.hop === HopKind.OutEnd) && !isStoreVia(r.via) && r.peer) set.add(r.peer);
  return [...set];
}
