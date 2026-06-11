import { createRequire } from "node:module";
import { describe, expect, test } from "bun:test";
import { tagTraces } from "~/lib/otlp-tag.server";

// Regression guard for the OTLP org-tagging proxy (QA C2). tagTraces() must add
// org_id to every customer trace WITHOUT corrupting the payload it forwards. An
// earlier toObject/fromObject round-trip risked collapsing the AnyValue int/bool
// oneof and dropping Span.status — which would silently kill error highlighting
// (/traces, /traces/:id) and show wrong HTTP status in /requests. These tests
// assert int/bool attributes + Span.status survive the tag step, so any future
// change that reintroduces a lossy round-trip fails here instead of in prod.

const require = createRequire(import.meta.url);
const root = require("@opentelemetry/otlp-transformer/build/src/generated/root.js");
const T = root.opentelemetry.proto.collector.trace.v1.ExportTraceServiceRequest;

const STATUS_CODE_ERROR = 2;

/** Encode a realistic OTLP/protobuf ExportTraceServiceRequest, SDK-style. */
function encodeTrace(): Buffer {
  const obj = {
    resourceSpans: [
      {
        resource: {
          attributes: [{ key: "service.name", value: { stringValue: "checkout-api" } }],
        },
        scopeSpans: [
          {
            scope: { name: "test-instr" },
            spans: [
              {
                traceId: Buffer.alloc(16, 7),
                spanId: Buffer.alloc(8, 3),
                name: "POST /pay",
                kind: 2,
                startTimeUnixNano: 1000n,
                endTimeUnixNano: 2000n,
                attributes: [
                  { key: "http.method", value: { stringValue: "POST" } },
                  { key: "http.route", value: { stringValue: "/pay" } },
                  { key: "http.status_code", value: { intValue: 500 } },
                  { key: "error", value: { boolValue: true } },
                ],
                status: { code: STATUS_CODE_ERROR, message: "boom" },
              },
            ],
          },
        ],
      },
    ],
  };
  return Buffer.from(T.encode(T.fromObject(obj)).finish());
}

type AnyVal = { value?: string; stringValue?: string; intValue?: unknown; boolValue?: boolean };
function attrVal(attrs: Array<{ key: string; value: AnyVal }>, key: string): AnyVal | undefined {
  return attrs.find((a) => a.key === key)?.value;
}

describe("tagTraces", () => {
  test("preserves int/bool attributes and Span.status while adding org_id (C2 regression)", () => {
    const tagged = tagTraces(encodeTrace(), "org_abc");
    const out = T.decode(tagged);

    const rs = out.resourceSpans[0];
    const span = rs.scopeSpans[0].spans[0];

    // String attributes were never at risk — sanity only.
    expect(attrVal(span.attributes, "http.method")?.stringValue).toBe("POST");
    expect(attrVal(span.attributes, "http.route")?.stringValue).toBe("/pay");

    // Int attribute: value AND the AnyValue oneof must be intValue (not collapsed to a bool 1).
    const statusCode = attrVal(span.attributes, "http.status_code");
    expect(statusCode?.value).toBe("intValue");
    expect(Number(statusCode?.intValue)).toBe(500);

    // Bool attribute: oneof must stay boolValue and the value true.
    const errAttr = attrVal(span.attributes, "error");
    expect(errAttr?.value).toBe("boolValue");
    expect(errAttr?.boolValue).toBe(true);

    // Span.status must survive intact (drives error highlighting via otel.status_code).
    expect(span.status?.code).toBe(STATUS_CODE_ERROR);
    expect(span.status?.message).toBe("boom");

    // The whole point: org_id stamped on the resource AND every span.
    expect(attrVal(rs.resource.attributes, "org_id")?.stringValue).toBe("org_abc");
    expect(attrVal(span.attributes, "org_id")?.stringValue).toBe("org_abc");
    // ...and service.name is still readable for the per-org services registry.
    expect(attrVal(rs.resource.attributes, "service.name")?.stringValue).toBe("checkout-api");
  });

  test("re-tagging is idempotent — exactly one org_id per resource and span", () => {
    const once = tagTraces(encodeTrace(), "org_abc");
    const twice = tagTraces(once, "org_abc");
    const out = T.decode(twice);
    const rs = out.resourceSpans[0];
    const span = rs.scopeSpans[0].spans[0];
    expect(rs.resource.attributes.filter((a: { key: string }) => a.key === "org_id").length).toBe(1);
    expect(span.attributes.filter((a: { key: string }) => a.key === "org_id").length).toBe(1);
  });

  test("fail-safe: empty orgId forwards the body untouched (platform traces never break)", () => {
    const body = encodeTrace();
    expect(tagTraces(body, "")).toBe(body);
  });

  test("fail-safe: undecodable body is returned untouched rather than thrown", () => {
    const garbage = Buffer.from([0xff, 0xff, 0xff, 0x01, 0x02]);
    expect(tagTraces(garbage, "org_abc")).toBe(garbage);
  });
});
