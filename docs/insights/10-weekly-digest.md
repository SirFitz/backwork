# 10 Weekly digest (BAC-77)

Wave 3. Depends on: 2 (slow queries), 5 (alert events, channels), 6 (compare, deploys), 7 (fix-first), 1 (repeat scan), foundation (tables, jobs). Feeds: none.

## Goal
Once a week, send one message to Slack, Discord, a webhook or email with what needs attention: the biggest things to fix, what got slower, what errored, what shipped, how usage stands. Never twice, never missed after a restart.

## What exists (notes C sections 1, 2)
Alert channels (webhook, Slack, Discord, email via the channel's own SMTP, SMS) with `send(channel, msg)` taking `{title, body, severity}` plain text; a system mailer `sendMail(to, subject, text)` (SES, then SMTP, then console) used for invites and resets. Background jobs are lazy in-process timers. VictoriaMetrics keeps 14 days; Loki hop records 30 days (Free 3).

## Design

### Content (pure `lib/digest/build.ts`)
```ts
export interface DigestInput {
  orgName: string; now: number; weekStart: number;
  fixFirst: FixItem[];                 // feature 7, top 5
  regressions: CompareRow[];           // feature 6, week over week (24 h vs the same 24 h a week ago), top 5
  newRepeats: RepeatRow[];             // feature 1 scan, top 3
  errorGroups: ErrorGroupSummary[];    // new or growing error groups this week, top 5
  alertEvents: { rule: string; firedAt: number; resolvedAt: number | null }[];   // feature 5 history
  deploys: Deploy[];                   // this week
  usage: { requests: number; includedRequests: number | null; bytes: number; includedBytes: number | null } | null;
  unavailable: string[];               // sections that failed to load
}
export interface Digest { title: string; body: string; emailText: string; quiet: boolean }
export function buildDigest(i: DigestInput): Digest;
```
- Sections in order, each omitted when empty: **Fix first** (rank, title, impact label), **Slower than last week**, **Repeated calls**, **Errors**, **Alerts this week** (count, longest), **Deploys** (count and the latest few), **Usage** (one line against the plan allowance, from `loadDaily`).
- Plain text, short lines, `-` bullets, durations with units, no em dashes, no emoji; one link to `/insights` at the end. Title "backwork weekly: <org name>, week of 10 Nov".
- A week with nothing to report sends a short "All quiet" message (`quiet: true`) so the schedule stays visible; sections that failed to load are named in a final "Not available this week: slow queries" line rather than silently missing.
- Slack and Discord get `body` (Slack `*title*\nbody`); webhook gets the JSON plus `sections` (structured); email gets `emailText`.

### Settings
`routes/alerts.tsx` gains a card **Weekly digest** (admin and owner only, audited `digest.update`, `digest.test`): switch, weekday and hour (stored UTC; the UI shows the local equivalent "Mondays at 08:00 UTC, 03:00 your time"), channel multi-select (existing channels), a checkbox "Email owners and admins" (members with those roles through `sendMail`), "Send a test now" (builds and sends right away, does not claim the week), last sent and last error line.

### Scheduling that cannot double send
`lib/digest/schedule.server.ts`, started from `startBackgroundJobs()`; timer every 15 minutes (`.unref()`):
1. Load enabled `digest_settings`; for each, compute the scheduled instant for the current week (`weekday`, `hour_utc`) and `period_start` (the scheduled date).
2. Due when `now >= scheduled` and `now < scheduled + 24 h` and no completed run for `period_start`.
3. **Claim**: `INSERT INTO digest_runs (org_id, period_start) VALUES (...) ON CONFLICT DO NOTHING RETURNING *`; only the process that gets a row builds and sends. An existing row with `error` set and `attempts < 3` and older than 1 hour is re-claimed with `UPDATE ... SET attempts = attempts + 1 ... WHERE sent_at IS NULL AND claimed_at < now() - interval '1 hour' RETURNING`.
4. Build the input with each source in `safe` and a 30 second budget per source; send to every selected channel and the email recipients; record `sent_at` or `error` (per channel outcome in the row's error text).
Idempotent across restarts and processes; a digest missed by more than 24 hours is skipped (not sent late) and the next week proceeds.

## Files
New: `lib/digest/build.ts` (+ test), `lib/digest/inputs.server.ts`, `lib/digest/schedule.server.ts`, `lib/digest/store.server.ts` (+ DB test), `components/insights/digest-card.tsx`. Changed: `routes/alerts.tsx` (card, action intents), `lib/jobs.server.ts` (start the schedule), `lib/audit.server.ts` consumers (`digest.*` names).

## Tests
- `buildDigest`: each section present or omitted; quiet week; unavailable sections named; ordering; line lengths; no em dashes; Slack text, email text and webhook JSON shapes; dates in UTC.
- Schedule maths: due window, week boundaries, daylight saving irrelevance (UTC), weekday and hour edges, late run skipped.
- DB tests (opt-in): two concurrent claims produce one winner; failed send retried after an hour up to 3 attempts; sent runs never re-claimed; a second week is a new period.
- Settings action: member role refused, admin accepted, audit rows written; channel from another org refused.
- Send fan-out with fake channels: one failing channel does not stop the others and is recorded.

## Verification
Local scenario: set the digest to the current hour with a local webhook receiver, see exactly one message though two dashboard processes run; "Send a test now" posts the same content; email path through the console mailer shows the text; restart during a send does not double send; quiet-week message when the scenario is idle. Read the Slack-format body for lines that wrap badly. 1440 and 390 screenshots of the settings card.

## Risks
Sources are slow (Loki aggregates): each is bounded and falls back to its stale cache. Email deliverability depends on the system mailer configuration (SES or SMTP env) which is outside this change: when neither is configured the send is logged and the run records `error: mailer not configured`. Digest content must not leak other organisations: every source is tenant scoped.

## Out of scope
Per-user subscriptions, HTML email, charts in the digest, other cadences.
