# Fixture emitter (tests only)

`emitter.ts` writes spec-exact Correlator hop records (spec 13.1), link lines (LOG-5) and ordinary log lines for the
two sample requests of the design frames:

| Request | Trace ID | Shape |
|---|---|---|
| `POST /orders` (frame 2) | `6503f5f183b828139d5b143365ad72fa` (x-request-id `F8Zx2o1yQk0AAAEB`) | healthy; risk call with a cache get, payments call with two db calls and an acquirer call, db insert, a queued job picked up 2.3 s later; named fields `f_order_id`, `f_currency`; linked IDs `order_id`, `acquirer_ref` |
| `POST /payouts/:id/release` (frame 3) | `9c2f41d07be3a6158d04f2c7b91e60aa` | commerce-payments stalls on `bank-gw.internal`, commerce-api times out at 30 s (504), a job to `notifications` has no receiver; linked ID `payout_id` |

After that, one generated `POST /orders` every `CYCLE_S` seconds (every fifth is a 422), one ordinary line per service,
and on commerce-api one line with a card number, an email, a phone number and `MBR-123456` (filter probe).

The local stack runs four emitters, one per service, in different line formats (`docker-compose.local.yml`):
commerce-api `json` (pino style), commerce-payments `kv` (Elixir console style), commerce-risk `json-nested`
(fields under `metadata`), commerce-worker `kv`.

Without Docker: `SERVICE=commerce-api FORMAT=kv CYCLE_S=10 bun qa/fixtures/emitter.ts`.
