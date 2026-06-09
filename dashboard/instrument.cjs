// OpenTelemetry bootstrap, preloaded via `node --require ./instrument.cjs`.
// Traces the dashboard's own HTTP handling and its outbound calls to Loki /
// VictoriaMetrics / Jaeger / the Docker socket, exporting OTLP to Jaeger.
// Wrapped defensively: if tracing fails to start, the dashboard still serves.
try {
  const { NodeSDK } = require("@opentelemetry/sdk-node");
  const { getNodeAutoInstrumentations } = require("@opentelemetry/auto-instrumentations-node");
  const { OTLPTraceExporter } = require("@opentelemetry/exporter-trace-otlp-http");
  const { Resource } = require("@opentelemetry/resources");
  const { SemanticResourceAttributes } = require("@opentelemetry/semantic-conventions");

  const endpoint = (process.env.OTLP_ENDPOINT || "http://jaeger:4318") + "/v1/traces";
  const sdk = new NodeSDK({
    resource: new Resource({
      [SemanticResourceAttributes.SERVICE_NAME]: process.env.OTEL_SERVICE_NAME || "backwork-dashboard",
    }),
    traceExporter: new OTLPTraceExporter({ url: endpoint }),
    instrumentations: [
      getNodeAutoInstrumentations({
        "@opentelemetry/instrumentation-fs": { enabled: false },
        "@opentelemetry/instrumentation-dns": { enabled: false },
      }),
    ],
  });
  sdk.start();
  process.stdout.write(JSON.stringify({ level: "info", service: "backwork-dashboard", msg: "tracing initialized -> " + endpoint }) + "\n");
  const shutdown = () => sdk.shutdown().catch(() => {}).finally(() => process.exit(0));
  process.on("SIGTERM", shutdown);
} catch (e) {
  process.stdout.write(JSON.stringify({ level: "warn", service: "backwork-dashboard", msg: "tracing init failed: " + (e && e.message) }) + "\n");
}
