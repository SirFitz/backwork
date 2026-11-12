/**
 * Builds the agent config the installer writes, plus a controls file for a
 * project with switches off, into infra/vector/agent/build/, for the Vector
 * unit tests in tests.yaml. Run: infra/vector/agent/test.sh
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { agentConfigYaml, controlsTransformYaml, defaultSnapshot } from "../../../dashboard/app/lib/agent/vector-config.server";
import { FEATURES, type Feature } from "../../../dashboard/app/lib/controls.server";

const out = join(import.meta.dir, "build");
mkdirSync(out, { recursive: true });
writeFileSync(
  join(out, "agent.yaml"),
  agentConfigYaml().replaceAll("__NAME__", "test-host").replaceAll("__ENDPOINT__", "http://backwork.test/ingest").replaceAll("__TOKEN__", "test-token").replaceAll("__INCLUDE__", '"commerce-", "svc-"'),
);
const snap = defaultSnapshot();
snap.version = "test";
snap.project = { ...snap.project, named_fields: false };
const muted = Object.fromEntries(FEATURES.map((f) => [f, f !== "hops" && f !== "named_fields"])) as Record<Feature, boolean>;
const noLogs = Object.fromEntries(FEATURES.map((f) => [f, f !== "logs" && f !== "named_fields" && f !== "stores"])) as Record<Feature, boolean>;
// Query text off for one service (BAC-51); everything else as the project.
const noQuery = { ...snap.project, statements: false } as Record<Feature, boolean>;
snap.services = { "svc-no-hops": muted, "svc-no-logs": noLogs, "svc-no-query": noQuery };
snap.patterns = [...snap.patterns, { name: "member", pattern: "MBR-\\d{6}", replacement: "[filtered]" }, { name: "end", pattern: "secret-tail$", replacement: "[filtered]" }];
writeFileSync(join(out, "controls.yaml"), controlsTransformYaml(snap));
console.log(`wrote ${out}`);
