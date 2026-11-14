# 11 Pin the worst requests (BAC-78)

Wave 2. Depends on: foundation (`pinned_requests`, `pin_settings`, jobs), 1 and 3 settle the request view. Feeds: none.

## Goal
Keep the requests worth keeping after the retention window drops them: pin one by hand from the request view, or let backwork keep the slowest and failed ones automatically, within a per-plan cap. A pinned request opens exactly like a live one.

## What exists (notes C section 6)
Loki keeps request records for 30 days (3 on Free) and ordinary lines for 7 days; compaction cannot exempt a line, so nothing in Loki survives longer, whatever filters the trim job uses. The only way to keep a request is to copy it into Postgres. The request view rebuilds the whole tree in the browser from raw records, log lines and links (`HopRecord[]`, `TraceLogLine[]`, `LinkedId[]`).

## Design

### Snapshot
`lib/pins.server.ts`:
```ts
export const PinReason = { Manual: "manual", Slow: "slow", Failed: "failed" } as const;
export type PinReason = (typeof PinReason)[keyof typeof PinReason];
export interface PinnedRequest { traceId: string; title: string; note: string | null; reason: PinReason; bytes: number; pinnedAt: number; pinnedBy: string | null; summary: RequestSummary }
export interface PinSnapshot { records: HopRecord[]; lines: TraceLogLine[]; links: LinkedId[] }
export function pinRequest(ctx: OrgContext, traceId: string, snap: PinSnapshot, o: { reason: PinReason; note?: string; title: string }): Promise<PinResult>;
export function unpinRequest(orgId: string, traceId: string): Promise<void>;
export function loadPin(orgId: string, traceId: string): Promise<(PinnedRequest & PinSnapshot) | null>;
export function listPins(orgId: string, limit: number, before?: number): Promise<PinnedRequest[]>;
```
- The snapshot is the **same raw data the request view already holds** (post `splitRequests` for the pinned part), serialised as JSON; the browser posts nothing large: the pin action re-fetches server side with `progressiveLookup` + `logLinesFor` (so a client cannot pin forged data) and stores it.
- Caps: 2 MB per snapshot (over the cap, log lines are cut first, then oldest records, and the pin says "trimmed"); count per plan through `PIN_LIMITS = { free: 5, team: 100, business: 500, unmetered: 200 }` (Enterprise 500). Over the cap: manual pin refused with "You have 5 of 5 pinned requests on the Free plan. Unpin one first."; auto pins evict the oldest **auto** pin, never a manual one.
- Idempotent: pinning twice updates the note.
- Privacy: records and lines are already filtered at ingest; unpin removes the row; deleting the organisation cascades.

### Auto-pin job
`lib/pins-auto.server.ts`, run hourly from `startBackgroundJobs()` for orgs whose `pin_settings` enable it (default off):
- `pickAutoPins(rows: RequestListRow[], existing: PinnedRequest[], settings, now): AutoPick[]` (pure): from the last hour's inbound end records (the list query), the slowest finished request (reason `slow`, only if it is at least 2x its route's median among the rows and at least 500 ms) and the first failed one (reason `failed`) not already pinned; at most 3 auto pins per org per day.
- Each pick is snapshotted through the same `pinRequest`.
- Settings card on `/settings` (admin): "Keep the slowest request of each day", "Keep failed requests (up to 3 a day)", with "Pinned: 3 of 5".

### Request view and list
- Request view loader: look up Loki first; **if nothing is found, or the request is older than the plan window**, fall back to `loadPin` and render from the snapshot with a neutral banner "Pinned copy saved 10 Nov 14:02. The live records have expired." The tree, split, verdict and diff all work on it (same raw data).
- Header action (member role and above): `Pin` / `Unpin` button with an optional note field (a small popover in the top layer, one input, "Keep" button); a neutral `Badge` "Pinned" in the title row; the reason and note shown in the facts row.
- Requests list: a `Pinned` filter chip (`?pinned=1`) switches the feed to `listPins` rows (Title, Status, Took, Reason, Pinned by, When, Note) with load-more paging; the rest of the list is unchanged.
- Audit: `pin.add`, `pin.remove`, `pin.auto` with trace id and reason.

## Files
New: `lib/pins.server.ts` (+ DB test), `lib/pins.ts` (pure caps, `pickAutoPins`, + test), `lib/pins-auto.server.ts`, `components/insights/pin-button.tsx`, `components/insights/pinned-banner.tsx`. Changed: `routes/requests_.$id.tsx` (loader fallback, action intents `pin`/`unpin`, header mount), `routes/requests.tsx` (filter chip and pinned feed), `routes/settings.tsx` (auto-pin card), `lib/jobs.server.ts`.

## Tests
- Pure: caps per plan, over-cap behaviour for manual vs auto, eviction chooses oldest auto, `pickAutoPins` thresholds (2x median and 500 ms; fewer than 5 rows gives no slow pick), daily limit, already pinned skipped.
- DB (opt-in): pin, load, list order, update note, unpin, plan cap refused, 2 MB trimming, cascade on organisation delete; snapshot round trip: `buildRequestTree` of the stored records equals the tree of the originals (same summary, same split).
- Action: viewer refused, member allowed, cross-origin refused, trace id validated, snapshot comes from server data not the request body.
- Loader fallback: Loki empty plus pin renders the snapshot; Loki present ignores the pin.

## Verification
Local scenario: pin the N+1 request, delete its records from the local Loki (delete API with a short cancel period, or restart Loki with an empty volume), reload: the pinned copy renders with the banner, Path view, verdict and logs; the Pinned filter lists it; Free cap refuses the sixth; auto-pin picks the scenario's slow and failed requests once per day. 1440 and 390 screenshots; the pin popover is in the top layer and not clipped (UI_ISSUES 2 check at 1280, 1024, 768, 390).

## Risks
A 2 MB cap and 500 pins per org bound table size; `jsonb` TOAST keeps rows out of the hot path. Pinning something whose records are partly truncated stores the truncation and says so. Old pinned records could outlive a later change to the record format: `parseHopRecord` already tolerates unknown fields, and the pin stores parsed `HopRecord`s plus a `v: 1` marker for future migration.

## Out of scope
Sharing a pin by public link, exporting, pinning log searches, keeping Loki lines past retention for anything but pinned requests.
