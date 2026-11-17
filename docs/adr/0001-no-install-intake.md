# ADR 0001: No-install intake goes through the stack collector

Status: accepted (BAC-96, 2026-11-17). Context: BAC-95, "customers never give us access to their
servers"; backwork must take hop records and log lines without the agent.

## Decision

`POST /ingest/records` (and the OTLP logs endpoint built on it) is a thin authenticated front for
the pipeline that already exists:

1. The dashboard route resolves the project ingest token (`resolveIngestToken`), reads the body
   (5 MB limit before and after gzip, 413 over it), splits it into lines and groups them into the
   streams an agent push carries (hop records under their own `service` field, other lines under
   the posted service).
2. It runs `enforceStreams`, the same pass every agent push gets in the Loki ingest proxy:
   switches, excluded paths, source-to-service naming and the organisation's sensitive-data
   filter, then derived error groups and metered usage (`afterStored`, now shared by both routes).
   Each line is wrapped in an envelope first, so a JSON log line with a `message` field is filtered
   as a whole and stored as posted.
3. It posts the kept lines as NDJSON to an `http_server` input (`records`, port 8687, compose
   network only) on the stack's own Vector. That input feeds copies of the collectors' own
   transforms, generated from `dashboard/app/lib/agent/vector-config.server.ts`: level and display
   text, `bw_detect`, the controls program (re-detection, NestJS levels, hop naming, slimming), and
   the `backwork_hop_*` metric transforms with `org_id` and `project` labels. Lines go to Loki with
   `org_id`, `project`, `service`, `source`, `host`, `level`, `kind` labels; the metrics go out on
   the existing Prometheus exporter that VictoriaMetrics scrapes. Retention by `kind` is Loki's,
   as for every line.

`infra/vector/vector.yaml` is regenerated from the module (`cd dashboard && bun
../infra/vector/generate.ts`); the staleness test and `infra/vector/test.sh` cover the new input.
The stack stays at five containers.

## Why this and not a TypeScript port

- One source of truth. Hop detection, the controls program and every metric (histogram buckets,
  tags, the optional store counters, the label-value limit) stay in the one module both collectors
  are generated from. A port would be a third copy of the metric logic, and the cumulative
  histograms and counters would need their own in-process state, persistence across restarts and
  a writer to VictoriaMetrics.
- Switches and the filter are per organisation and project, which a static Vector config cannot
  express. The dashboard already enforces them in TypeScript for agent pushes (`enforceStreams`,
  pinned to the Vector rules by its tests), so the records path enforces them there, before the
  lines reach the collector, and tells the collector the two switches it acts on after detection
  (Performance figures, Database and cache) per line. The collector's controls program for this
  input runs with everything on and no patterns, so a built-in pattern an organisation switched
  off is never applied behind its back.
- No new container: Vector is already there, already writes to Loki and is already scraped.

## Consequences

- The `records` input is unauthenticated inside the compose network; only the dashboard can reach
  it. It must never be published on a host port.
- Vector acknowledges a post only after the sinks took it (`acknowledgements`), so the route
  answers 502 when the collector or Loki is down, and the client's retry is not double counted.
- The records metric pipeline has one `tag_cardinality_limit` for all tenants (20,000 values per
  label instead of the agent's 2,000 per host). A tenant that floods `op` values can push the
  limit for others; per-tenant limits are a follow-up if intake volume grows.
- Authentication: `Authorization: Bearer`, `x-backwork-token`, or HTTP Basic with the token as
  user or password. The last lets Correlator's existing record sink authenticate with the token in
  the URL (`https://<token>@backwork.dev/ingest/records?service=my-api`), with no change to it.
- Found while building this: kv link lines (`trace_id=... link_name=... link_value=...`) were
  detected as `kind="log"` by Vector's `bw_detect` (a missing regex group read as an empty line).
  The ingest proxy relabelled agents' link lines, so it showed only on the stack collector. Fixed
  in the shared module, with a Vector unit test.

## Addendum: OTLP logs (BAC-97)

`POST /ingest/otlp/v1/logs` decodes ExportLogsServiceRequest (protobuf with `protobufjs` 7.6.6,
pinned, from a schema of the opentelemetry-proto fields read; JSON by the OTLP/JSON rules), turns
each record into one line and hands the lines to the same intake. A body that is itself a
Correlator hop record or link line is kept as written, so it is detected and counted; any other
record becomes `{"level","msg","trace_id","span_id","attributes"}`, which the collectors read for
level and display text and whose `trace_id` links the line to its request. Record times are kept
when within 6 days back and 10 minutes ahead of the receive time, else the receive time is used.

Known limit: hop records posted to `/ingest/records` carry no time of their own (Correlator writes
none), so they are stored at receive time, up to the sink's flush interval (1 s) after they were
written. OTLP lines keep their real time. A line logged in the first moments of a short request can
then fall just before the hop's window in the request view (it still links to the request from
Logs). A per-line time from the record sink would close this; tracked as a follow-up.

## Addendum: line times and platform drains (BAC-98)

Line times. Every intake line may carry its own time (`IntakeLine.timeNs`); `linesToStreams`
keeps it when it is within `TIME_WINDOW_NS` of the receive time (6 days back, under Loki's 168 h
`reject_old_samples_max_age`; 10 minutes ahead, for clock skew) and otherwise uses the receive
time plus the line's position. One guard, in one place, for every route. The time becomes the
Loki timestamp (`bw_ts`) and the time of the hop metric events derived from the line, as an
agent's file timestamps do. On `POST /ingest/records` a plain text line carries its time as a
prefix and a tab:

    <time>\t<line>      time = RFC 3339 (any fraction, Z or an offset) or Unix epoch nanoseconds (exactly 19 digits)

`stampedLine` removes the prefix and the tab; a line without a valid prefix (a time followed by a
space, a short number, any other text before a tab) is stored as posted at the receive time. 19
digits only, so a pid or a count is never read as a time. Correlator's record sink stamps its
lines this way; older sinks keep working unchanged.

Platform drains. `POST /ingest/drains/<platform>` takes a platform's own drain format, one typed
parser per platform (`DrainPlatform`: vercel, heroku, fly, cloudflare) producing `DrainEntry`
(message, level, service, host, time, context fields), then the same records intake. Platform
metadata maps to the labels and the line time; a platform level, request and trace IDs go into
the stored line as `{"level","msg",...}`, the shape OTLP records use, so the collectors read the
level and display text and a trace ID links the line. A Correlator hop record or a structured
line with its own level is kept as written, so it is detected and counted, or keeps the app's
level. Authentication is the project token in a header wherever the platform allows one: a
custom header (Vercel), the log shipper's bearer token (Fly), Basic from the drain URL (Heroku,
the only way Logplex authenticates), and Cloudflare's `header_Authorization` destination
parameter, which Logpush sends as a request header (it has no other way to set a header); no
route reads a token from the query. Vercel's `x-vercel-signature` is not checked: it needs a
secret Vercel generates per drain, which backwork would have to store; the bearer token is the
check. Render (syslog over TLS to custom endpoints, HTTPS only for Datadog and Loggly) and Railway
(no drain) have no HTTP push; a TLS syslog listener for Render would need a public TCP port on
the stack and is not built.
