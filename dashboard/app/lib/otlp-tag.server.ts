import { createRequire } from "node:module";
import { and, eq, gte } from "drizzle-orm";
import { db, ensureSchema } from "~/db/index.server";
import { traceServices } from "~/db/schema";
import { cached } from "./cache.server";

// Inject an enforced org_id into OTLP trace exports at the proxy, so customer
// traces are isolated and can't be spoofed by the sending app. org_id is added
// to each ResourceSpans.resource AND to every span's attributes (span tags are
// what Jaeger reliably filters on). Fail-safe: any decode/encode error forwards
// the original body untouched (platform traces never break).

let ReqType: any | null = null;
let triedLoad = false;
function traceReqType(): any | null {
  if (triedLoad) return ReqType;
  triedLoad = true;
  try {
    const require = createRequire(import.meta.url);
    const root = require("@opentelemetry/otlp-transformer/build/src/generated/root.js");
    ReqType = root.opentelemetry.proto.collector.trace.v1.ExportTraceServiceRequest;
  } catch {
    ReqType = null;
  }
  return ReqType;
}

// org -> service names seen in its traces (Jaeger has no per-tenant
// /api/services). Persisted to DB (survives restarts) + an in-memory L1 for
// instant freshness within the process.
declare global {
  // eslint-disable-next-line no-var
  var __bwTraceServices: Map<string, Set<string>> | undefined;
}
function registry(): Map<string, Set<string>> {
  if (!globalThis.__bwTraceServices) globalThis.__bwTraceServices = new Map();
  return globalThis.__bwTraceServices;
}

async function recordOrgServices(orgId: string, services: string[]): Promise<void> {
  if (!services.length) return;
  try {
    await ensureSchema();
    await db
      .insert(traceServices)
      .values(services.map((service) => ({ orgId, service })))
      .onConflictDoUpdate({ target: [traceServices.orgId, traceServices.service], set: { lastSeen: new Date() } });
  } catch {
    /* best-effort; the in-memory L1 still serves this process */
  }
}

/** Service names for an org's trace dropdown: DB (cached, 14-day window) ∪ L1. */
export function orgTraceServices(orgId: string): Promise<string[]> {
  return cached(`traceSvc:${orgId}`, 20000, async () => {
    let fromDb: string[] = [];
    try {
      await ensureSchema();
      const cutoff = new Date(Date.now() - 14 * 24 * 3600 * 1000);
      const rows = await db
        .select({ service: traceServices.service })
        .from(traceServices)
        .where(and(eq(traceServices.orgId, orgId), gte(traceServices.lastSeen, cutoff)));
      fromDb = rows.map((r) => r.service);
    } catch {
      /* fall back to L1 */
    }
    const mem = registry().get(orgId) || new Set<string>();
    return [...new Set([...fromDb, ...mem])].sort();
  });
}

export function tagTraces(body: Buffer, orgId: string): Buffer {
  const T = traceReqType();
  if (!T || !orgId) return body;
  try {
    const obj = T.toObject(T.decode(body), { defaults: false, arrays: true });
    const orgKv = { key: "org_id", value: { stringValue: orgId } };
    const seen = registry().get(orgId) || new Set<string>();
    const batch = new Set<string>();
    for (const rs of obj.resourceSpans || []) {
      rs.resource = rs.resource || {};
      rs.resource.attributes = (rs.resource.attributes || []).filter((a: any) => a.key !== "org_id");
      rs.resource.attributes.push(orgKv);
      const svc = (rs.resource.attributes.find((a: any) => a.key === "service.name")?.value?.stringValue) || "";
      if (svc) { seen.add(svc); batch.add(svc); }
      for (const ss of rs.scopeSpans || []) {
        for (const sp of ss.spans || []) {
          sp.attributes = (sp.attributes || []).filter((a: any) => a.key !== "org_id");
          sp.attributes.push(orgKv);
        }
      }
    }
    registry().set(orgId, seen);
    if (batch.size) void recordOrgServices(orgId, [...batch]); // write-through, fire-and-forget
    return Buffer.from(T.encode(T.fromObject(obj)).finish());
  } catch {
    return body; // fail-safe
  }
}
