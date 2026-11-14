# 03 "Why was this slow?" verdict on a request (BAC-70)

Wave 2. Depends on: 1 (repeat groups). Feeds: 8.

## Goal
One plain sentence at the top of a request naming where its time went, so nobody has to read the Path view to find out. Example: "71 percent of the 588 ms was 7 Redis set calls, one after another (2.10 s of call time). The next biggest is select plans, 14 times."

## What exists (notes A)
`timeSplit(hop, now)` gives own, database, cache, waiting and background time for the first inbound hop; `TimeSplitBar` draws it. `rowUs`, `SLOW_SHARE (0.25)` mark slow rows. `requestProblems` and `failedCallsSentence` set the house pattern for pure sentence builders. Red `Alert` is for faults only.

## Design

### Pure module `lib/hops/verdict.ts`
```ts
export const VerdictKind = {
  RepeatedCalls: "repeated_calls",   // one repeat group dominates
  SlowCall: "slow_call",             // a single call dominates
  Waiting: "waiting",                // time spent waiting on other services
  OwnTime: "own_time",               // the service itself (own compute)
  Failed: "failed",                  // the request failed: defer to the Alert box, no verdict
  Fast: "fast",                      // nothing stands out
  Unknown: "unknown"                 // open, stalled or truncated: say so
} as const;
export type VerdictKind = (typeof VerdictKind)[keyof typeof VerdictKind];

export interface Verdict {
  kind: VerdictKind;
  sentence: string;           // plain English, units shown
  culpritHopId: HopId | null; // the hop or group head to scroll to
  share: number;              // 0..1 of the head hop's time
  detail: string | null;      // second sentence: the next biggest thing
}
export function whyItWasSlow(tree: RequestTree, repeats: RepeatReport, now: number): Verdict;
```

### Rules (first match wins; thresholds exported)
1. Tree has no head hop, or head is open or stalled: `Unknown`, "This request has not finished, so there is no timing to explain yet."
2. Head failed (`isFailed`): `Failed`, sentence null-ish; the Alert box explains, the verdict line is hidden.
3. Head duration below `FAST_US = 200_000` and no group over `20 percent`: `Fast`, hidden (no noise on fast requests).
4. Compute shares of head time: database time, cache time, waiting, own (from `timeSplit`), and the largest repeat group (`wastedUs` and `totalUs`).
5. If a repeat group's `totalUs` is at least `CULPRIT_SHARE = 0.4` of head time, `RepeatedCalls` and name it (`repeatSentence` style).
6. Else if one store or outbound call's duration is at least 0.4 of head time, `SlowCall` naming `storeLabel` or the destination.
7. Else if waiting time (calls to other services) is at least 0.5, `Waiting` naming the slowest destination service.
8. Else if own time is at least 0.5, `OwnTime`: "Most of the time, 340 ms, was spent inside checkout-api itself, not waiting on anything."
9. Else `Fast`/hidden.
`detail`: the next largest contributor above 15 percent, one clause.
Truncation (`tree` built from a capped fetch) appends "Some records were not loaded, so this may understate it." and the kind stays.

### Percent wording
Percent of the head hop's duration, rounded to whole numbers; call time summed across overlapping calls is called "call time" and never added to the percentage (use `TimeSplit.dbUs` union time for shares, `dbSumUs` only for the "call time" note).

## UI
- A single line above the `TimeSplitBar`: label "Why" (muted) and the sentence, `text-[13px]`, max two lines on desktop, one line plus truncation on phone with the full text in the title; clicking scrolls to and opens the culprit row (`culpritHopId` -> expand its path node).
- Hidden for `Fast`, `Failed`, no verdict. No colour: neutral text; no icon.
- On the request list, no verdict (too expensive); feature 7 shows verdict-like text from figures instead.

## Files
New: `lib/hops/verdict.ts`, `verdict.test.ts`, `components/insights/why-line.tsx`. Changed: `routes/requests_.$id.tsx` (mount the line in `OneRequest`, memoised on `tree`; scroll-to helper), nothing else.

## Tests
Fixtures from `tree.test.ts` builders: healthy POST /orders (fast, hidden); request dominated by 14 sequential selects (RepeatedCalls, names the shape, share); one 900 ms call (SlowCall); fan-out waiting on a slow downstream (Waiting names it); long own time (OwnTime); failed request (Failed, hidden); open request (Unknown); percent never exceeds 100 with overlapping calls; truncation suffix; thresholds at the boundaries (0.39 vs 0.40); sentences contain units and no em dash.

## Verification
Local scenario requests: `/shop` says repeated calls, `/orders/:id` says slow call, `/checkout` says waiting; click scrolls and opens the row; 1440 and 390; line never wraps past two lines on desktop; no layout shift when the logs load (the tree is built twice, once without logs: the line must be computed from the first build and stay stable).

## Risks
The tree is rebuilt when logs arrive; the verdict must not flicker between builds (derive only from hop records, which are identical). Clock skew can inflate "own time"; skewed hops (`skewMs != 0`) lower the verdict's confidence: append "Timings across services may be off by a few milliseconds." when any hop in the culprit path has skew above 50 ms.

## Out of scope
Natural-language summaries of logs, cross-request comparison (feature 8).
