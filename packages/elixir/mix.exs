defmodule Backwork.MixProject do
  use Mix.Project

  def project do
    [
      app: :backwork,
      version: "0.1.0",
      elixir: "~> 1.15",
      description: "One-call OpenTelemetry tracing for backwork.dev.",
      package: package(),
      deps: deps(),
      name: "backwork",
      source_url: "https://github.com/SirFitz/backwork"
    ]
  end

  def application, do: [extra_applications: [:logger]]

  defp deps do
    [
      {:opentelemetry_api, "~> 1.4"},
      {:opentelemetry, "~> 1.5"},
      {:opentelemetry_exporter, "~> 1.8"},
      # add whichever your app uses — they're optional:
      {:opentelemetry_phoenix, "~> 2.0", optional: true},
      {:opentelemetry_bandit, "~> 0.2", optional: true},
      {:opentelemetry_cowboy, "~> 1.0", optional: true},
      {:opentelemetry_ecto, "~> 1.2", optional: true},
      {:ex_doc, ">= 0.0.0", only: :dev, runtime: false}
    ]
  end

  defp package do
    [
      licenses: ["MIT"],
      links: %{"backwork" => "https://backwork.dev", "GitHub" => "https://github.com/SirFitz/backwork"},
      files: ~w(lib mix.exs README.md)
    ]
  end
end
