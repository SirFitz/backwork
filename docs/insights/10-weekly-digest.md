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

## As built (deviations and details settled in the BAC-77 PR)
- **More pure modules.** Besides `build.ts`: `schedule.ts` (the schedule maths, weekday labels and the local-time hint, used by the card in the browser), `settings.ts` (intents, the stored shape, the form parser, the card's data types) and `delivery.ts` (per-destination outcomes). `schedule.server.ts` keeps the timer, the tick and the fan-out. The loader data and the action live in `card.server.ts` (`loadDigestCard`, `handleDigestAction`) with injectable dependencies, so the role and channel checks are tested without a request.
- **Input types.** `build.ts` never imports a `.server` module, so the repeats, error groups and usage come in as narrow pure types (`DigestRepeat`, `DigestErrorGroup`, `DigestUsage`). `DigestInput` also carries `insightsUrl`, `settingsUrl`, the window phrases and `repeatsSampled`; `Digest` carries `link` and `sections`.
- **Windows.** Fix first and the repeats scan read their longest window (6 hours, behind their caches) and the sections say so ("Fix first (last 6 hours)"); "Slower than last week" is the 24 hours against the same 24 hours a week ago; errors, alerts and deploys cover the 7 days before the send. The title's "week of" is the first of those 7 days.
- **Errors** are the open groups seen this week, marked "new" when first seen this week, with their occurrences this week counted from `error_events` (no stored "growing" measure exists).
- **Usage** is this calendar month so far against the monthly allowance (`loadUsageView`, which reads `loadDaily`); an unmetered organisation has no Usage line, a Free plan shows its figures without an allowance.
- **Retries per destination.** A run records each destination's answer (channel, or each owner's or admin's email) as JSON in `digest_runs.error`; a re-claimed run sends only to the destinations that failed, so nobody gets the week twice. A disabled or deleted channel is recorded as skipped and not retried. A run that stopped mid-send (no `sent_at`, no `error`) is never re-claimed: a missed week rather than a double one.
- **Messages.** Email channels get `emailText`; Slack, Discord and webhooks get `body` with the link; webhooks also get `sections` and `quiet` as JSON fields (`send` already passes every field of the message, so `channels.server.ts` is unchanged). The system mailer's console fallback counts as "mailer not configured".
- **Card.** "Send a test now" uses the saved settings (save first), sends to the organisation's own channels only, and never touches `digest_runs`. Members and viewers see a one-line summary; the action refuses them with 403 (`digest.update`, `digest.test` audited). The local half of the time hint is computed after hydration, since the server has no time zone.
- `lib/jobs.server.test.ts` lists the new job.

## Out of scope
Per-user subscriptions, HTML email, charts in the digest, other cadences.
