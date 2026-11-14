# 04 Chatty-request and could-run-in-parallel flags (BAC-71)

Wave 2. Depends on: foundation (exported interval helpers, `RequestListRow.totals`), 1 (batched detection). Feeds: none.

## Goal
1. **Chatty requests**: spot requests that make an unusual number of database and cache calls, on the Requests list and on the request itself.
2. **Could run in parallel**: spot calls that one service made back to back that do not depend on each other, and say how much time running them together would save.

## What exists (notes A)
Each inbound `in_end` record already carries `db_n`, `db_us`, `cache_n`, `cache_us`; the list parses them and drops them. Tree hops have exact start and end times; the interval helpers (`mergeIntervals`, `subtractIntervals`, `lengthUs`) are private in `tree.ts` (foundation exports them). Clock skew across services is unreliable; same-service siblings share a clock.

## Design

### Chatty (list and request)
`lib/hops/chatty.ts` (pure):
```ts
export const CHATTY_CALLS = 50;            // absolute floor: db plus cache calls in one request
export const CHATTY_FACTOR = 3;            // times the route's median among loaded rows
export const CHATTY_MIN_SAMPLE = 8;        // rows of the same route needed for a relative test
export interface ChattyVerdict { chatty: boolean; calls: number; reason: "absolute" | "relative" | null; routeMedian: number | null; dbShare: number | null }
export function chattyRow(row: Pick<RequestListRow, "route" | "totals" | "durationMs">, rows: readonly RequestListRow[]): ChattyVerdict;
export function chattyRequest(tree: RequestTree): ChattyVerdict;
```
- `calls = dbCalls + cacheCalls` from `totals`; `chatty` when `calls >= CHATTY_CALLS` or (sample of at least 8 loaded rows of the same route and `calls >= CHATTY_FACTOR * median` and `calls >= 10`).
- List: rows without `totals` are never flagged. A neutral `Badge` "chatty" with title "142 database and cache calls; this route's median is 12". Filter chip "Chatty only" (client side, over loaded rows, like the existing status/method filters). Sort option "Most calls".
- Request: header fact "N database and cache calls" already exists; when chatty it gets the same neutral badge. (Verdict sentence is feature 3's.)

### Could run in parallel (request view)
`lib/hops/concurrency.ts` (pure):
```ts
export interface ParallelCandidate {
  parentHopId: HopId; service: string;
  hopIds: HopId[];            // 2..N sibling calls, in start order, that ran back to back
  labels: string[];           // "get redis.internal", "select plans"
  serialUs: number;           // time they took one after another
  parallelUs: number;         // the longest of them: what running together would take
  savedUs: number;            // serialUs - parallelUs
  independent: "unknown";     // we cannot see data dependencies: always worded as a possibility
}
export function parallelCandidates(tree: RequestTree): ParallelCandidate[];
export function parallelSentence(c: ParallelCandidate): string;
```
Rules:
1. Per inbound hop, take direct children that are not `afterResponse` or `handoff`, not folded pipelines' members, and not part of a `Batched` or concurrent repeat group (feature 1).
2. Order by start. A **chain** is a run of at least 2 calls where each starts within `GAP_US = 2_000` after the previous one ended (`>= prev.end - 1 ms` and `<= prev.end + 2 ms`), so the code between them did almost no work (a data dependency usually leaves compute in between; this is a heuristic and the wording says "could").
3. Exclude chains whose later call name or table appears in the earlier call's own result? Not knowable: always `independent: "unknown"`.
4. Different repeat shapes are fine; identical-shape repeats are feature 1's N+1 and are excluded here (they have their own hint).
5. Only report when `savedUs >= MIN_SAVED_US = 20_000` (20 ms) and the chain has at most 12 calls.
6. Cross-service siblings: only compare calls made by the same inbound hop; their start times come from that hop's service clock for stores; for HTTP calls the caller-side `out` hop is used (not the callee's), so skew does not matter.
Sentence: "3 calls from checkout-api ran one after another (get redis.internal, get redis.internal, select orders, 41 ms). If they do not depend on each other, running them together could take about 14 ms and save 27 ms."

## UI
- Request view: path rows of the chain get a neutral chip "could run together" and a left-aligned detail fact ["Could run together", sentence]; the `Why` line (feature 3) may mention the largest candidate in `detail`.
- Requests list: "chatty" badge and filter chip as above, no extra row height (badge sits inside the existing method/route cell on desktop; on phone appended to the meta line).
- Nothing in the red Alert box. No percentage claims beyond the sentence.

## Files
New: `lib/hops/chatty.ts`, `chatty.test.ts`, `lib/hops/concurrency.ts`, `concurrency.test.ts`, `components/insights/parallel-chip.tsx`. Changed: `lib/hops/requests.server.ts` is foundation (totals); `routes/requests.tsx` (badge, chip, sort), `routes/requests_.$id.tsx` (chip and detail mount), `lib/hops/tree.ts` is foundation (exports).

## Tests
- Chatty: 50 calls flags; 49 does not; relative test needs 8 rows of the route; rows without totals ignored; median with even counts; filter and sort pure helpers.
- Concurrency: three calls back to back (gap 1 ms) form a chain with correct serial, parallel and saved times; a 10 ms compute gap breaks the chain; overlapping calls are not reported (already parallel); identical-shape repeats excluded; plain pipeline of 12 gets excluded; `handoff` and `afterResponse` calls ignored; saved below 20 ms not reported; cross-service HTTP calls use the caller-side hop; chain longer than 12 not reported; stability when records arrive out of order; 5000-hop tree under 100 ms.

## Verification
Insights scenario: `/orders/:id` shows the 3-call chain and the saving; the 12-get pipeline shows nothing; a `/shop` request is chatty (above 50 calls) and its list row shows the badge; "Chatty only" filters; 1440 and 390; list rows keep their height.

## Risks
The heuristic can suggest things that truly depend on each other: the sentence says "if they do not depend on each other" and never "should". The relative chatty test only uses loaded rows (page of 100); the title says so.

## Out of scope
Detecting actual data dependencies, auto-rewrite suggestions, per-route chatty baselines from figures (a metrics-based baseline could replace the loaded-row median later).
