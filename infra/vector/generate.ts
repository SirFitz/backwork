/**
 * Writes infra/vector/vector.yaml from dashboard/app/lib/agent/vector-config.server.ts.
 *   bun infra/vector/generate.ts          (write)
 *   bun infra/vector/generate.ts --check  (exit 1 when the file is stale)
 * Run from the repository root, with dashboard/node_modules installed.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stackConfigYaml } from "../../dashboard/app/lib/agent/vector-config.server";

const target = join(import.meta.dir, "vector.yaml");
const want = stackConfigYaml();
if (process.argv.includes("--check")) {
  const have = readFileSync(target, "utf8");
  if (have !== want) {
    console.error("infra/vector/vector.yaml is stale: run bun infra/vector/generate.ts");
    process.exit(1);
  }
  console.log("infra/vector/vector.yaml is up to date");
} else {
  writeFileSync(target, want);
  console.log(`wrote ${target}`);
}
