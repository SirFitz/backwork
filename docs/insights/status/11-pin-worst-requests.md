# 11 Pin the worst requests: status

Branch `bac-78-pin-requests`, worktree `backwork-wt/ins-pin`, cut from origin/main 1be6601.
Baseline before changes: `tsc --noEmit` exit 0; `bun test` 588 tests, 0 fail, 7 skip, exit 0.

## 1. Pure module `lib/pins.ts`: in progress
- `lib/pins.ts` + `lib/pins.test.ts` (20 tests): caps, `pinSlot`, `trimSnapshot`, `describeSnapshot`, `pinnedCopyWanted`, `pickAutoPins`. Done.

## 2. Server: `lib/pins.server.ts`, `lib/pins-auto.server.ts`, jobs: done
- Store, read, list, cap under an org row lock, 2 MB trimming, settings, `pinAction`, `withPinFallback`, `fetchSnapshot`.
- `runAutoPins` / `startAutoPins` (hourly, first run after 5 min), `JobName.AutoPins` in `startBackgroundJobs`.
- `lib/pins.server.test.ts`: 10 non-DB tests (action: viewer, member, cross-origin, trace id, cap, unpin; fallback: Loki empty, Loki present, older than plan window, pin lookup failing) and 2 DB tests on `bw_ins_78`: 12 pass, 0 fail.

## 3. UI: in progress
