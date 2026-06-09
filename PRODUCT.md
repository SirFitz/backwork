# backwork.dev — Product Context

register: product

## Product purpose

Self-hosted log aggregation + application performance monitoring for developers
running mixed Docker infrastructure. It ingests real container telemetry (logs
via Vector, resource metrics via cAdvisor, traces via Jaeger when apps emit
them), retains it cheaply, and surfaces what is broken right now: crashes,
restarts, error spikes, resource pressure. The product replaces expensive hosted
tools (AppSignal, LogDNA/Mezmo) with a developer-owned alternative that stays
under ~$50/mo in infra.

It monitors a real Docker host. The reference deployment watches ~80 production
containers (the inkress app fleet). Data is never synthetic.

## Users

Solo developers and small platform teams who self-host many services on a few
VPSs. They are technical, comfortable with LogQL/PromQL, and value density and
speed over hand-holding. Primary job: "is anything broken, and where?" Secondary:
"this container is slow/leaking, show me why." They check it during the workday
and when paged at night.

## Brand & tone

Confident, terse, engineering-native. No marketing fluff, no emoji, no
exclamation. Copy reads like a good CLI: precise nouns, real numbers, units
always shown. The brand mark is a lowercase wordmark `backwork.dev` with a single
coral accent carried over from the product brief. Coral is identity only; it
never signals status.

## Anti-references (do NOT look like these)

- Generic SaaS dashboards: 4 identical gradient stat cards in a row, big hero
  number, pastel everything. Forbidden.
- The "observability = dark navy on black with neon blue" cliché. We default to
  light, warm-neutral surfaces; dark is an opt-in toggle, not the identity.
- Grafana's stock look (cluttered, every panel boxed identically).
- Datadog purple maximalism.

## Strategic principles

1. Truth over polish-theatre. Every number is real and live; if a backend is
   down, the panel says so plainly rather than showing zeros.
2. Density with hierarchy. This is a scanning tool. Tables and inline sparklines
   over big cards. One clear focal point per screen (what's broken).
3. Status color is sacred: green/amber/red mean operational/degraded/down and
   nothing else. Brand coral is never a status.
4. Light by default (daytime glance), dark by choice (night triage).
5. Honest about limits: traces require instrumented apps; if none emit spans, the
   Traces view says so instead of faking it.
