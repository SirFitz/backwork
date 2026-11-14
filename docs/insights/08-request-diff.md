# 08 Request diff (BAC-75)

Wave 3. Depends on: 1 (repeat groups), 3 (verdict wording). Feeds: none.

## Goal
Put a slow request beside a typical fast one of the same route and show exactly what differs: which calls took longer, which ran more times, which only one of them made.

## What exists (notes A)
Request trees (`buildRequestTree`), time splits, path rows with stable shape keys, `splitRequests`, the request list query, and the one-trace lookup (`progressiveLookup`, `logLinesFor`). Hop ids differ per request, so alignment must use content. The list filters by route client side only (no LogQL route filter yet).

## Design

### Choosing the comparison
`lib/hops/typical.server.ts`: `typicalRequest(tenant, head: RequestSummary, now): Promise<{ traceId: string; durationMs: number } | null>`:
1. Recent inbound end records for the same `(service, method, route)` over the last hour with a LogQL line filter on the route's `op` text (`inboundEndQuery` extended with an optional `route` filter; escaped, 200 records).
2. Candidates: finished, not failed (or both failed when the head failed), not the head itself, duration within 0.8x to 1.25x of the route's median among candidates; pick the one nearest the median; if fewer than 5 candidates, the fastest.
3. Returns null when no candidate exists ("No other requests of this route in the last hour to compare with.").
The request page offers **Compare with a typical request**; the user can also paste another request ID on the compare page.

### Pure diff `lib/hops/diff.ts`
```ts
export interface DiffRow {
  key: string;                      // `${service}|${via}|${op}|${table ?? ""}|${shapeId ?? ""}|${occurrence}`
  label: string;                    // storeLabel or "service op"
  depth: number;
  a: { durationUs: number; calls: number } | null;   // calls: 1, or the group size
  b: { durationUs: number; calls: number } | null;
  deltaUs: number;                  // a - b (missing side counts as 0)
  kind: "same" | "slower" | "faster" | "only_a" | "only_b" | "more_calls" | "fewer_calls";
}
export interface RequestDiff {
  a: Side; b: Side;                 // summary: startMs, durationUs, status, services, calls
  totalDeltaUs: number;
  splitDelta: { dbUs: number; cacheUs: number; waitingUs: number; ownUs: number };
  rows: DiffRow[];                  // aligned, in path order of A then unmatched of B
  top: DiffRow[];                   // the largest contributors by |deltaUs|, at most 6
  sentences: string[];              // plain English, max 3
}
export function diffRequests(a: RequestTree, b: RequestTree): RequestDiff;
```
- **Alignment**: build path nodes for both (`buildPathNodes`), flatten with depth; key = service, via, op, table and `shapeId` of the statement, plus occurrence index among siblings with the same key; repeat groups align as one row carrying `calls`. Rows match when keys match; unmatched rows become `only_a` or `only_b`.
- `slower` when the row's `deltaUs` is at least 10 ms and at least 25 percent of its B time; `faster` is the mirror; `more_calls` or `fewer_calls` when group call counts differ by at least 3. Constants are exported and tested at their boundaries.
- Sentences, ranked by contribution: "The slow request took 588 ms and the typical one 164 ms: 424 ms more. Most of the difference, 352 ms, is select orders (412 ms against 60 ms). It also made 12 more calls to select plans, and called payments-api, which the typical request did not."
- Truncated trees say so; different routes allowed with a warning line.

## UI
Route `routes/requests_.$id.vs.$other.tsx` (`/requests/:id/vs/:other`), render-first: a header card with two columns (A: "This request" with start, duration, status, services; B: "Typical request" with the same, plus change/paste controls), the `sentences` as the lead, then:
1. **What differs**: top contributors list (label, A time, B time, difference bar; row links scroll to the aligned row).
2. **Side by side**: one table: Hop (indented by depth) | A | B | Difference (signed bar, amber for slower, neutral for faster). 38 px rows, folded by default to rows that differ (toggle "Show all"), groups show "x14 against x2".
Phone: columns stack as A over B inside each row; the table scrolls inside its own container. Loader settles each trace independently (one failing shows its own error). States: skeleton, "not found" per side, "no typical request found".
Entry points: a button in the request header actions (`Compare`) and a link in the "Why" line when the verdict names repeated calls ("Compare with a typical request").

## Files
New: `lib/hops/diff.ts` (+ test), `lib/hops/typical.server.ts` (+ test), `routes/requests_.$id.vs.$other.tsx`, `components/insights/diff-table.tsx`. Changed: `lib/hops/requests.server.ts` (optional `route` filter in `inboundEndQuery`, + test), `routes/requests_.$id.tsx` (button mount only).

## Tests
- Diff: identical requests give all `same`; one extra call group; a slower store call; a missing downstream service; repeat group with 14 vs 2; key stability with reordered siblings; occurrence index for identical siblings; sentences read correctly for each case; totals add up (sum of row deltas explains the total within unmatched time); different routes warn.
- `typicalRequest`: median selection, fastest fallback with fewer than 5, excludes the head and failed ones, null when none; the LogQL route filter is escaped.
- Component states render.

## Verification
Scenario: a `/shop` request with the regression trigger on against one without: the diff names the doubled calls; `/orders/:id` slow shape shows `slower`; the paste-an-ID control works; 1440 and 390 screenshots.

## Risks
Two traces means two Loki lookups (each up to 5000 lines): they run in parallel with independent errors. Alignment by content can mismatch repeated identical siblings; the occurrence index keeps order stable but is a heuristic (documented in the file header).

## Out of scope
Diffing logs, diffing across organisations, saving comparisons.

## As built (deviations settled in the BAC-75 PR)
- **Route file** is `routes/requests_.$id_.vs.$other.tsx`, not `requests_.$id.vs.$other.tsx`: with the plan's name Remix nests the page under the request view, which has no outlet, so it never renders. The URL is the planned `/requests/:id/vs/:other`; `other` is a trace ID or `typical` (`TYPICAL_PARAM`), in which case the loader finds the typical request after the first trace settles.
- **Keys.** A row's key is the path of its parent keys plus its own (joined by a newline, since a route can hold any printable text). Store calls key on service, via, command, table, host, statement shape id and MULTI commands (the host and MULTI commands added to the plan's list, matching `callShapeKey`). Every call of one store key under one parent is one row with its call count, whether or not the Path card folds it (it folds from 3), so 14 against 2 is one row. Top-level hops key on service, direction and via only, so different routes line up at the top and carry the warning. Calls not recorded one by one are a row of their own under their hop.
- **Faster** mirrors slower with the roles swapped: B took at least 10 ms and 25 percent of A's time longer.
- **Contributors.** `DiffRow` gains `contributionUs` (what the row adds by itself: its delta less its rows' deltas, 0 when overlapping calls explain more; the whole delta at the top of a part only one request has, 0 inside it), `hasChildren`, `store`, `parentKey` and `id` (8 hex of the key, for element ids). `top` ranks by `contributionUs`, so the request row appears only for time outside its calls ("own time"). Rows with differing call counts and the top of a one-sided part always qualify; others from 10 ms.
- **Sentences.** "This request took X and the typical request Y: Z more" (or "less", or "about the same" within 10 ms or 10 percent of B). The second names the largest contributor ("Most of the difference" from half of the total, else "The largest difference"); the third lists up to two of: more or fewer calls, calls only one made, then the next largest times. When B was pasted it is "the other request". Warnings (different routes, records cut at the fetch limit, a request still running) are a separate `warnings` list, drawn under the sentences; `diffRequests` takes an optional `DiffOptions` (`aTruncated`, `bTruncated`, `otherName`).
- **Which request of a trace.** A trace holding several requests (`splitRequests`) is compared by its first one.
- **Typical request** (`typicalRequest`, `pickTypical`): the LogQL route filter is a quoted `|= "<op>"` substring after the via filter; rows still match service, method and route exactly. A failed head is compared with failed requests only. Health-check routes are searched with health checks shown.
- **Entry point.** The Compare button sits at the end of the request header's facts row (shown for finished inbound HTTP requests). The "Compare with a typical request" link in the Why line is not added: `components/insights/why-line.tsx` belongs to feature 3, and the brief allowed only the button mount on the request view.
- **Not run:** the `/shop` regression-trigger scenario (the shared fixture stack is read only for this feature); two ordinary `/shop` requests are compared instead (about the same, no differing rows).
