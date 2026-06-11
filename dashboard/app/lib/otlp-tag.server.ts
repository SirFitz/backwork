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
let KeyValueType: any | null = null;
let triedLoad = false;
function loadTypes(): any | null {
  if (triedLoad) return ReqType;
  triedLoad = true;
  try {
    const require = createRequire(import.meta.url);
    const root = require("@opentelemetry/otlp-transformer/build/src/generated/root.js");
    ReqType = root.opentelemetry.proto.collector.trace.v1.ExportTraceServiceRequest;
    KeyValueType = root.opentelemetry.proto.common.v1.KeyValue;
  } catch {
    ReqType = null;
    KeyValueType = null;
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
  const T = loadTypes();
  if (!T || !orgId) return body;
  try {
    // Decode to a message INSTANCE and mutate it in place — do NOT round-trip
    // through toObject/fromObject, which dropped Span.status and collapsed the
    // AnyValue int/bool oneof (C2). Untouched fields (status, int/bool attrs)
    // re-encode byte-for-byte; we only add org_id KeyValues.
    const msg: any = T.decode(body);
    const mkKv = () => (KeyValueType ? KeyValueType.create({ key: "org_id", value: { stringValue: orgId } }) : { key: "org_id", value: { stringValue: orgId } });
    const seen = registry().get(orgId) || new Set<string>();
    const batch = new Set<string>();
    for (const rs of msg.resourceSpans || []) {
      if (!rs.resource) rs.resource = {};
      rs.resource.attributes = (rs.resource.attributes || []).filter((a: any) => a.key !== "org_id");
      rs.resource.attributes.push(mkKv());
      const svc = rs.resource.attributes.find((a: any) => a.key === "service.name")?.value?.stringValue;
      if (svc) { seen.add(svc); batch.add(svc); }
      for (const ss of rs.scopeSpans || []) {
        for (const sp of ss.spans || []) {
          sp.attributes = (sp.attributes || []).filter((a: any) => a.key !== "org_id");
          sp.attributes.push(mkKv());
        }
      }
    }
    registry().set(orgId, seen);
    if (batch.size) void recordOrgServices(orgId, [...batch]); // write-through, fire-and-forget
    return Buffer.from(T.encode(msg).finish());
  } catch {
    return body; // fail-safe
  }
}

/** Same enforced org_id injection for OTLP/HTTP JSON bodies. Without this, a
 *  customer using a JSON exporter would ship UNTAGGED spans (invisible to their
 *  own scoped view, leaking into the platform's unfiltered view). Fail-safe: any
 *  parse error returns the original body. */
export function tagTracesJson(body: Buffer, orgId: string): Buffer {
  if (!orgId) return body;
  try {
    const msg = JSON.parse(body.toString("utf8"));
    const kv = { key: "org_id", value: { stringValue: orgId } };
    const seen = registry().get(orgId) || new Set<string>();
    const batch = new Set<string>();
    for (const rs of msg.resourceSpans || []) {
      if (!rs.resource) rs.resource = {};
      rs.resource.attributes = (rs.resource.attributes || []).filter((a: any) => a.key !== "org_id");
      rs.resource.attributes.push(kv);
      const svc = rs.resource.attributes.find((a: any) => a.key === "service.name")?.value?.stringValue;
      if (svc) { seen.add(svc); batch.add(svc); }
      for (const ss of rs.scopeSpans || []) {
        for (const sp of ss.spans || []) {
          sp.attributes = (sp.attributes || []).filter((a: any) => a.key !== "org_id");
          sp.attributes.push(kv);
        }
      }
    }
    registry().set(orgId, seen);
    if (batch.size) void recordOrgServices(orgId, [...batch]);
    return Buffer.from(JSON.stringify(msg));
  } catch {
    return body;
  }
}
