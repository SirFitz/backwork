import { resolveConfig, applyEnvDefaults, warnIfNoToken } from "./config.mjs";

export { resolveConfig };

let started = false;

/**
 * Start backwork tracing programmatically (NodeSDK under the hood — works on
 * Node and Bun). Usually you don't call this directly; prefer importing
 * "@backwork/node/register" (Node) or "@backwork/node/start" (Bun) as a preload.
 *
 * @param {{ token?: string, service?: string, endpoint?: string }} [overrides]
 */
export async function start(overrides = {}) {
  if (started) return;
  started = true;
  const cfg = resolveConfig(overrides);
  warnIfNoToken(cfg.token);
  if (!cfg.token) return;
  applyEnvDefaults(cfg);

  const { NodeSDK } = await import("@opentelemetry/sdk-node");
  const { getNodeAutoInstrumentations } = await import("@opentelemetry/auto-instrumentations-node");
  const { OTLPTraceExporter } = await import("@opentelemetry/exporter-trace-otlp-proto");

  const sdk = new NodeSDK({
    traceExporter: new OTLPTraceExporter(), // reads the OTEL_* env we just set
    instrumentations: [getNodeAutoInstrumentations()],
  });
  sdk.start();

  const stop = () => { Promise.resolve(sdk.shutdown()).catch(() => {}); };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  return sdk;
}
