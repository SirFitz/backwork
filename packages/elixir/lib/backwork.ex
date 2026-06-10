defmodule Backwork do
  @moduledoc """
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
  """

  require Logger

  @default_endpoint "https://backwork.dev/otlp"

  @doc """
  Returns the keyword config for `:opentelemetry_exporter`. Reads `BACKWORK_TOKEN`
  and `BACKWORK_ENDPOINT` from the environment; override with `:token` / `:endpoint`.
  """
  @spec exporter_config(keyword) :: keyword
  def exporter_config(opts \\ []) do
    token = opts[:token] || System.get_env("BACKWORK_TOKEN") || ""
    endpoint = opts[:endpoint] || System.get_env("BACKWORK_ENDPOINT") || @default_endpoint

    if token == "", do: Logger.warning("[backwork] BACKWORK_TOKEN is empty — traces will be rejected (401).")

    [
      otlp_protocol: :http_protobuf,
      otlp_endpoint: endpoint,
      otlp_headers: [{"authorization", "Bearer " <> token}]
    ]
  end

  @doc """
  Attach the OpenTelemetry instrumentation for whichever libraries are present.
  Call once from `Application.start/2`.

  Options:
    * `:phoenix_adapter` — `:bandit` (default) or `:cowboy2`
    * `:ecto` — list of telemetry prefixes, e.g. `[[:my_app, :repo]]`
  """
  @spec setup(keyword) :: :ok
  def setup(opts \\ []) do
    maybe(OpentelemetryPhoenix, :setup, [[adapter: opts[:phoenix_adapter] || :bandit]])
    maybe(OpentelemetryBandit, :setup, [])
    maybe(OpentelemetryCowboy, :setup, [])
    for prefix <- List.wrap(opts[:ecto]), do: maybe(OpentelemetryEcto, :setup, [prefix])
    :ok
  end

  defp maybe(mod, fun, args) do
    if Code.ensure_loaded?(mod) and function_exported?(mod, fun, length(args)) do
      apply(mod, fun, args)
    end
  end
end
