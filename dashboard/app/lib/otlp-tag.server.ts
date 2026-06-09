import { createRequire } from "node:module";

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

// orgId -> set of service names seen in that org's traces (for the scoped
// service dropdown; Jaeger has no per-tenant /api/services). In-memory: rebuilds
// as traces flow; resets on restart.
declare global {
  // eslint-disable-next-line no-var
  var __bwTraceServices: Map<string, Set<string>> | undefined;
}
function registry(): Map<string, Set<string>> {
  if (!globalThis.__bwTraceServices) globalThis.__bwTraceServices = new Map();
  return globalThis.__bwTraceServices;
}
export function orgTraceServices(orgId: string): string[] {
  return [...(registry().get(orgId) || [])].sort();
}

export function tagTraces(body: Buffer, orgId: string): Buffer {
  const T = traceReqType();
  if (!T || !orgId) return body;
  try {
    const obj = T.toObject(T.decode(body), { defaults: false, arrays: true });
    const orgKv = { key: "org_id", value: { stringValue: orgId } };
    const seen = registry().get(orgId) || new Set<string>();
    for (const rs of obj.resourceSpans || []) {
      rs.resource = rs.resource || {};
      rs.resource.attributes = (rs.resource.attributes || []).filter((a: any) => a.key !== "org_id");
      rs.resource.attributes.push(orgKv);
      const svc = (rs.resource.attributes.find((a: any) => a.key === "service.name")?.value?.stringValue) || "";
      if (svc) seen.add(svc);
      for (const ss of rs.scopeSpans || []) {
        for (const sp of ss.spans || []) {
          sp.attributes = (sp.attributes || []).filter((a: any) => a.key !== "org_id");
          sp.attributes.push(orgKv);
        }
      }
    }
    registry().set(orgId, seen);
    return Buffer.from(T.encode(T.fromObject(obj)).finish());
  } catch {
    return body; // fail-safe
  }
}
