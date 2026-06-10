# backwork (Elixir)

One-call OpenTelemetry tracing for [backwork.dev](https://backwork.dev). Wraps the
`opentelemetry_*` exporter config and instrumentation setup so you don't hand-wire
raw OTel.

> Logs and host/container metrics come from the backwork agent (`curl … install.sh`).
> This package is only for distributed traces / APM from inside your app.

## Install

In `mix.exs`, add `:backwork` plus the instrumentation libs your app uses:

```elixir
def deps do
  [
    {:backwork, "~> 0.1"},
    {:opentelemetry_phoenix, "~> 2.0"},  # if Phoenix
    {:opentelemetry_bandit, "~> 0.2"},   # or :opentelemetry_cowboy
    {:opentelemetry_ecto, "~> 1.2"}      # if Ecto
  ]
end
```

## Use

1. Create a **Project** in backwork and copy its ingest token; set `BACKWORK_TOKEN`.
2. Configure the exporter in `config/runtime.exs`:

```elixir
config :opentelemetry, traces_exporter: :otlp
config :opentelemetry_exporter, Backwork.exporter_config()
```

3. Attach instrumentation in `application.ex`, before your supervisor children:

```elixir
def start(_type, _args) do
  Backwork.setup(phoenix_adapter: :bandit, ecto: [[:my_app, :repo]])
  children = [...]
  Supervisor.start_link(children, strategy: :one_for_one, name: MyApp.Supervisor)
end
```

Name the service with `OTEL_RESOURCE_ATTRIBUTES=service.name=my-app`.

## Config

| Env | Default | Notes |
|-----|---------|-------|
| `BACKWORK_TOKEN` | — | **required** — project ingest token |
| `BACKWORK_ENDPOINT` | `https://backwork.dev/otlp` | self-hosted? point at your own host |

Within ~30s of the first request your service appears under **Traces**, **Requests**
and **Metrics → Application performance**.
