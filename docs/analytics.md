# Analytics (Flatlytics): BAC-103

backwork.dev measures its own product with Flatlytics (cookieless). backwork also stores customers' request
paths and log lines, so the rule is: **the tracker never runs on a screen whose URL can carry customer data,
and nothing customer-owned (ids, tokens, paths, log text, emails) ever leaves in an event.**

## Config (env, all optional)

| Variable | Meaning |
|---|---|
| `FLATLYTICS_SITE_KEY` | Public key (`fl_pub_...`). Unset: no script, no CSP change, no server calls. |
| `FLATLYTICS_SECRET_KEY` | Secret key for server events. Unset: server events off. |
| `FLATLYTICS_SCRIPT_URL` | f.js URL (https only). Default: the workers.dev ingest. |
| `FLATLYTICS_EVENT_ORIGIN` | Host used in the `u` field of server events. Default: the origin of `PUBLIC_URL`. |
| `FLATLYTICS_TEST_MODE` | `1` only on a local test build: lets f.js run on localhost and under automation. Never on a deployed app. |

Read at runtime (no rebuild). The stack is a docker-compose app: each variable is named in the `backwork`
service's `environment:` in `docker-compose.yaml` (Coolify passes only the variables a compose file names).
Prod uses the `backwork.dev` site key. There is no dev deployment; a local build uses the shared dev + QA key.

## Where the tracker runs

Only on an exact allow-list of bare screens, with no query string or fragment (`app/lib/analytics/paths.ts`):
the public pages (`/`, `/pricing`, `/docs`, `/about`, `/security`, `/privacy`, `/terms`, `/changelog`,
`/login`, `/register`, `/forgot`, `/onboarding`) and the screens that mark activation: `/projects`,
`/requests`, `/performance`, `/errors`, `/insights`, `/alerts`, `/billing`. Never on `/requests/:id`,
`/traces/:id`, `/errors/:id`, `/logs`, `/invite/:token`, `/reset/:token`, settings, API keys, members, `/ingest/*`,
or any screen with `?env=`, `?q=` and the like.

- `app/components/Analytics.tsx` adds the script after hydration, only while on an allowed screen, with
  `data-spa="false"`, `data-vitals="false"` and `data-events="false"`: f.js stamps events with `location.href`, so
  automatic SPA pageviews would otherwise report a screen with an id or a search in its URL. Pageviews for later
  screens are sent by the component; events by `track()` (`app/lib/analytics/client.ts`), which re-checks the URL.
- The CSP names the ingest origin in `script-src` and `connect-src` on every document when configured
  (a visitor can start on `/logs` and navigate in-app to `/billing`); the browser allow-list decides what is sent.
- backwork-embed (the widget that runs on customers' sites) is a separate product and never loads this tracker.

## Event catalogue

Names and prop types live in `app/lib/analytics/events.ts`. Props are fixed vocabularies, plan slugs and booleans.

| Event | When | Props | From |
|---|---|---|---|
| `pageview` | An allowed screen is shown | none | browser |
| `cta_clicked` | A "Start free" or plan button on a public page | `location` (nav, mobile_menu, hero, footer, docs, pricing), `plan` on pricing | browser |
| `checkout_frame_failed` | The embedded Inkress checkout reported a failed attempt (declined, invalid, blocked) | `code`, `retryable` | browser |
| `signup_completed` | An account was created (email or Google) | `method`, `plan_requested` | server |
| `signup_failed` | Sign-up refused | `method`, `reason` (invalid_email, weak_password, email_taken, rate_limited, or a Google error code) | server |
| `login_failed` | Sign-in refused | `method`, `reason` (invalid_credentials, rate_limited, missing_fields, or a Google error code) | server |
| `organization_created` | An organisation was created | `plan_requested` | server |
| `project_created` | A project (ingest token) was created | `first` | server |
| `first_data_received` | A project's first lines arrived (the value moment). Stamped once in `projects.first_data_at`; projects older than 7 days are stamped silently | `after` (under_1h, under_1d, under_7d: project age) | server |
| `alert_created` | An alert rule was added | `metric` | server |
| `trial_started` | The 14-day no-card trial started | `plan` | server |
| `checkout_opened` | A paid checkout was opened | `plan`, `billing` | server |
| `subscription_started` | Inkress confirmed a paid subscription (read back with our key, not the frame's word) | `plan`, `billing`, `after_trial` | server |
| `checkout_failed` | An open checkout ended with no subscription (declined or abandoned) | `stage` | server |
| `renewal_declined` | A renewal payment failed (past due) | none | server |
| `subscription_cancelled` | The subscription was set to end | none | server |

Server events use fixed page URLs (`/register`, `/login`, `/onboarding`, `/projects`, `/alerts`, `/billing` on the
event origin), never an id, and all go out with one fixed User-Agent (`backwork-server`). They carry no identity, so
they cannot be funnel steps; they are goals (counts). Billing events are derived in one place
(`app/lib/analytics/billing-facts.ts`) from the billing row before and after each action or "look again at Inkress",
and facts with a natural key (a subscription, a checkout) get a deterministic event id plus an in-process once-guard,
so webhook + page-load reconciles do not double count.

## Adding an event

1. Add the name and prop shape to `app/lib/analytics/events.ts` (`ClientEvent`/`ClientEventProps` or `ServerEvent`/`ServerEventProps`); a server event also needs a fixed path in `EVENT_PATH` in `server.server.ts`.
2. Call `track(...)` (browser, allowed screens only) or `trackServer(...)` (server).
3. No ids, emails, names, tokens or free text in props. Add a test in `app/lib/analytics/analytics.test.ts`.

## Goals and funnels (prod site `backwork.dev`)

Goals (event): Signed up, Organization created, Project created, First data received, Alert created, Subscribed.
Funnels (page and browser steps only): **Visit to first project** (`/` > `/register` > `/onboarding` > `/projects`),
**Project to requests** (`/projects` > `/requests`), **Pricing to sign-up** (`/pricing` > `/register`).
