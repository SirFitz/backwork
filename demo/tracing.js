// OpenTelemetry bootstrap — preloaded before the app via `node --require`.
// Auto-instruments http/express/undici(fetch) so spans propagate across
// services (W3C traceparent), giving backwork real distributed traces.
// Wrapped defensively: if tracing fails, the service still serves + logs.
const SERVICE = process.env.SERVICE_NAME || 'demo';

try {
  const { NodeSDK } = require('@opentelemetry/sdk-node');
  const { getNodeAutoInstrumentations } = require('@opentelemetry/auto-instrumentations-node');
  const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-http');
  const { Resource } = require('@opentelemetry/resources');
  const { SemanticResourceAttributes } = require('@opentelemetry/semantic-conventions');

  const endpoint = (process.env.OTLP_ENDPOINT || 'http://jaeger:4318') + '/v1/traces';

  const sdk = new NodeSDK({
    resource: new Resource({
      [SemanticResourceAttributes.SERVICE_NAME]: SERVICE,
    }),
    traceExporter: new OTLPTraceExporter({ url: endpoint }),
    instrumentations: [
      getNodeAutoInstrumentations({
        '@opentelemetry/instrumentation-fs': { enabled: false },
        '@opentelemetry/instrumentation-dns': { enabled: false },
      }),
    ],
  });

  sdk.start();
  process.stdout.write(
    JSON.stringify({ ts: new Date().toISOString(), level: 'info', service: SERVICE, msg: `tracing initialized -> ${endpoint}` }) + '\n'
  );

  const shutdown = () => sdk.shutdown().catch(() => {}).finally(() => process.exit(0));
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
} catch (e) {
  process.stdout.write(
    JSON.stringify({ ts: new Date().toISOString(), level: 'warn', service: SERVICE, msg: 'tracing init failed: ' + (e && e.message) }) + '\n'
  );
}
