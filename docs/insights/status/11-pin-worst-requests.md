# 11 Pin the worst requests: status

Branch `bac-78-pin-requests`, worktree `backwork-wt/ins-pin`, cut from origin/main 1be6601.
Baseline before changes: `tsc --noEmit` exit 0; `bun test` 588 tests, 0 fail, 7 skip, exit 0.

## 1. Pure module `lib/pins.ts`: done
- `lib/pins.ts` + `lib/pins.test.ts` (20 tests): caps, `pinSlot`, `trimSnapshot`, `describeSnapshot`, `pinnedCopyWanted`, `pickAutoPins`. Done.

## 2. Server: `lib/pins.server.ts`, `lib/pins-auto.server.ts`, jobs: done
- Store, read, list, cap under an org row lock, 2 MB trimming, settings, `pinAction`, `withPinFallback`, `fetchSnapshot`.
- `runAutoPins` / `startAutoPins` (hourly, first run after 5 min), `JobName.AutoPins` in `startBackgroundJobs`.
- `lib/pins.server.test.ts`: 10 non-DB tests (action: viewer, member, cross-origin, trace id, cap, unpin; fallback: Loki empty, Loki present, older than plan window, pin lookup failing) and 2 DB tests on `bw_ins_78`: 12 pass, 0 fail.

## 3. UI: done
- `components/insights/pin-button.tsx` (top-layer `popover="manual"` note form), `pinned-banner.tsx`, `pinned-list.tsx` (chip + list + paging), `auto-pin-card.tsx`; mounts in `requests_.$id.tsx` (loader fallback, action, header), `requests.tsx` (`?pinned=1`), `settings.tsx` (card + `auto_pins` intent).

## 4. Live checks (dev server :3504 on shared Loki, :3505 on an empty throwaway Loki `bw-ins-78-loki`)
- Pinned by curl: GET /shop (24 records), GET /orders/:id (6), POST /checkout (10, 3 services): 200; `pin.add` audited.
- Same summary live vs pinned copy against the empty Loki (durations 35861 / 274531 / 90716 us, db calls 22 / 1+3 cache / 0, identical split); page on :3505 shows "Pinned copy saved", Took 35.9 ms / 275 ms / 90.7 ms as on :3504.
- Cross-origin POST: 403 "cross-origin request blocked". Viewer: 403 "Viewers cannot pin requests."; no Pin button rendered for a viewer.
- Free plan: sixth pin 409 "You have 5 of 5 pinned requests on the Free plan. Unpin one first."
- Auto-pin run on the shared stack (Team plan, both switches on): pinned the failed POST /payouts/po_8Kx2/release (504); second run pinned nothing. No fixture request reached 500 ms and 2x its route median, so the slow pick is shown by the unit and DB tests only.
- Not run (no browser tool allowed): popover top-layer check at 1280/1024/768/390, screenshots.

## 5. Final
- After merging origin/main: `npx tsc --noEmit` exit 0; `npx bun test` exit 0 (660 pass, 9 skip, 0 fail); with the database URL exit 0 (668 pass, 1 skip, 0 fail); `npx remix vite:build` exit 0.
