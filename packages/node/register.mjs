// Side-effect entry for Node's --import (or as the first import in your entry
// file):
//   node --import @sirfitz/backwork/register server.js
// Sets the OTEL_* env from BACKWORK_* then defers to the official
// auto-instrumentations register hook, which installs the ESM loader hooks needed
// to instrument ESM imports — coverage the plain SDK can't match on Node.
import { resolveConfig, applyEnvDefaults, warnIfNoToken } from "./config.mjs";

const cfg = resolveConfig();
warnIfNoToken(cfg.token);
if (cfg.token) {
  applyEnvDefaults(cfg);
  await import("@opentelemetry/auto-instrumentations-node/register");
}
