// Resolve backwork tracing config from overrides + environment, and translate it
// into the standard OTEL_* env vars the OpenTelemetry SDK already understands.
export function resolveConfig(overrides = {}) {
  const token = overrides.token ?? process.env.BACKWORK_TOKEN ?? "";
  const base = (overrides.endpoint ?? process.env.BACKWORK_ENDPOINT ?? "https://backwork.dev/otlp").replace(/\/+$/, "");
  const service =
    overrides.service ?? process.env.BACKWORK_SERVICE ?? process.env.OTEL_SERVICE_NAME ?? process.env.npm_package_name ?? "unknown-service";
  return { token, endpoint: base, tracesUrl: base + "/v1/traces", service };
}

export function applyEnvDefaults(cfg) {
  const set = (k, v) => { if (!process.env[k]) process.env[k] = v; };
  const auth = `Authorization=Bearer ${cfg.token}`;
  set("OTEL_SERVICE_NAME", cfg.service);
  // Set BOTH the base endpoint (some exporters append /v1/traces) AND the
  // signal-specific endpoint (used as-is) so every OTel code path — the explicit
  // SDK and the auto-instrumentations register — resolves to backwork instead of
  // the localhost:4318 default.
  set("OTEL_EXPORTER_OTLP_ENDPOINT", cfg.endpoint);
  set("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT", cfg.tracesUrl);
  set("OTEL_EXPORTER_OTLP_HEADERS", auth);
  set("OTEL_EXPORTER_OTLP_TRACES_HEADERS", auth);
  set("OTEL_EXPORTER_OTLP_PROTOCOL", "http/protobuf");
  set("OTEL_EXPORTER_OTLP_TRACES_PROTOCOL", "http/protobuf");
  set("OTEL_TRACES_EXPORTER", "otlp");
  // backwork takes metrics + logs from the agent, not OTLP — keep app exporters quiet
  set("OTEL_METRICS_EXPORTER", "none");
  set("OTEL_LOGS_EXPORTER", "none");
}

export function warnIfNoToken(token) {
  if (!token) console.warn("[backwork] No ingest token found — set BACKWORK_TOKEN. Tracing is disabled.");
}
