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
