# `Backwork`
[🔗](https://github.com/SirFitz/backwork/blob/main/lib/backwork.ex#L1)

One-call OpenTelemetry tracing for [backwork.dev](https://backwork.dev).

There are two pieces — one boot-time, one runtime:

  1. **Exporter config** (boot-time) in `config/runtime.exs`:

         config :opentelemetry, traces_exporter: :otlp
         config :opentelemetry_exporter, Backwork.exporter_config()

  2. **Instrumentation** (runtime) in your `Application.start/2`, before the
     supervisor children start:

         Backwork.setup(phoenix_adapter: :bandit, ecto: [[:my_app, :repo]])

Set `BACKWORK_TOKEN` to your project's ingest token, and optionally
`OTEL_RESOURCE_ATTRIBUTES=service.name=my-app` so it's named in backwork.

Logs and host/container metrics come from the backwork agent — this package is
only for distributed traces / APM.

# `exporter_config`

```elixir
@spec exporter_config(keyword()) :: keyword()
```

Returns the keyword config for `:opentelemetry_exporter`. Reads `BACKWORK_TOKEN`
and `BACKWORK_ENDPOINT` from the environment; override with `:token` / `:endpoint`.

# `setup`

```elixir
@spec setup(keyword()) :: :ok
```

Attach the OpenTelemetry instrumentation for whichever libraries are present.
Call once from `Application.start/2`.

Options:
  * `:phoenix_adapter` — `:bandit` (default) or `:cowboy2`
  * `:ecto` — list of telemetry prefixes, e.g. `[[:my_app, :repo]]`

---

*Consult [api-reference.md](api-reference.md) for complete listing*
