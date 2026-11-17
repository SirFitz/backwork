import { describe, expect, test } from "bun:test";
import { Level, OtlpContentType, OtlpFormatError, TIME_WINDOW_NS, decodeRequest, levelOf, lineOf, otlpContentType, toIntakeLines } from "./otlp.server";
import { linesToStreams } from "./records.server";

const TRACE = "6503f5f183b828139d5b143365ad72fa";
const SPAN = "1f0a6c2e9b7d4405";
const NOW = 1_763_400_000_000_000_000n;
const T1 = NOW - 5_000_000_000n;

// --- a hand-built protobuf body (independent of the decoder's schema) ---
const varint = (n: number | bigint): number[] => {
  let v = BigInt(n);
  const out: number[] = [];
  do {
    let b = Number(v & 0x7fn);
    v >>= 7n;
    if (v > 0n) b |= 0x80;
    out.push(b);
  } while (v > 0n);
  return out;
};
const tag = (field: number, wire: number): number[] => varint((field << 3) | wire);
const len = (field: number, bytes: number[]): number[] => [...tag(field, 2), ...varint(bytes.length), ...bytes];
const str = (field: number, s: string): number[] => len(field, [...Buffer.from(s, "utf8")]);
const fixed64 = (field: number, v: bigint): number[] => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(v);
  return [...tag(field, 1), ...b];
};
const anyStr = (s: string): number[] => str(1, s);
const kv = (k: string, v: string): number[] => [...str(1, k), ...len(2, anyStr(v))];

function protobufBody(): Buffer {
  const record = [
    ...fixed64(1, T1),
    ...tag(2, 0), ...varint(17), // SEVERITY_NUMBER_ERROR
    ...str(3, "ERROR"),
    ...len(5, anyStr("charge failed password=hunter2")),
    ...len(6, kv("order.id", "7731")),
    ...len(9, [...Buffer.from(TRACE, "hex")]),
    ...len(10, [...Buffer.from(SPAN, "hex")]),
  ];
  const scopeLogs = [...len(1, str(1, "shop-logger")), ...len(2, record)];
  const resource = [...len(1, kv("service.name", "shop-api")), ...len(1, kv("host.name", "web-1"))];
  const resourceLogs = [...len(1, resource), ...len(2, scopeLogs)];
  return Buffer.from(len(1, resourceLogs));
}

const jsonBody = (): Buffer =>
  Buffer.from(JSON.stringify({
    resourceLogs: [{
      resource: { attributes: [{ key: "service.name", value: { stringValue: "shop-api" } }] },
      scopeLogs: [{
        scope: { name: "x" },
        logRecords: [
          { timeUnixNano: String(T1), severityNumber: 9, severityText: "INFO", body: { stringValue: "order placed" }, traceId: TRACE, spanId: SPAN, attributes: [{ key: "n", value: { intValue: "3" } }] },
          { observedTimeUnixNano: String(T1 + 1n), severityText: "warn", body: { kvlistValue: { values: [{ key: "a", value: { boolValue: true } }] } } },
        ],
      }],
    }],
  }));

describe("OTLP logs: decoding", () => {
  test("content types", () => {
    expect(otlpContentType("application/x-protobuf")).toBe(OtlpContentType.Protobuf);
    expect(otlpContentType("application/json; charset=utf-8")).toBe(OtlpContentType.Json);
    expect(otlpContentType("text/plain")).toBeNull();
  });
  test("protobuf: resource, severity, body, attributes, IDs, time", () => {
    const [rl] = decodeRequest(protobufBody(), OtlpContentType.Protobuf);
    expect(rl.resource).toEqual({ "service.name": "shop-api", "host.name": "web-1" });
    expect(rl.records).toEqual([{
      timeNs: T1, severityNumber: 17, severityText: "ERROR", body: "charge failed password=hunter2",
      attributes: { "order.id": "7731" }, traceId: TRACE, spanId: SPAN,
    }]);
  });
  test("JSON: hex IDs, string int64, observed time fallback, structured body", () => {
    const [rl] = decodeRequest(jsonBody(), OtlpContentType.Json);
    expect(rl.records[0]).toMatchObject({ timeNs: T1, traceId: TRACE, spanId: SPAN, attributes: { n: 3 } });
    expect(rl.records[1]).toMatchObject({ timeNs: T1 + 1n, body: { a: true }, traceId: "" });
  });
  test("garbage is a format error", () => {
    expect(() => decodeRequest(Buffer.from("{"), OtlpContentType.Json)).toThrow(OtlpFormatError);
    expect(() => decodeRequest(Buffer.from([0xff, 0xff, 0xff]), OtlpContentType.Protobuf)).toThrow(OtlpFormatError);
    expect(() => decodeRequest(Buffer.from('{"resourceLogs":3}'), OtlpContentType.Json)).toThrow(OtlpFormatError);
  });
});

describe("OTLP logs: to intake lines", () => {
  test("severity number ranges, then text", () => {
    expect([1, 5, 9, 13, 17, 21].map((n) => levelOf(n, ""))).toEqual([Level.Trace, Level.Debug, Level.Info, Level.Warn, Level.Error, Level.Fatal]);
    expect(levelOf(0, "Warning")).toBe(Level.Warn);
    expect(levelOf(0, "")).toBe(Level.Info);
  });
  test("an ordinary record is a JSON line with level, msg, trace_id and span_id", () => {
    const [rl] = decodeRequest(protobufBody(), OtlpContentType.Protobuf);
    expect(JSON.parse(lineOf(rl.records[0]))).toEqual({ level: "error", msg: "charge failed password=hunter2", trace_id: TRACE, span_id: SPAN, attributes: { "order.id": "7731" } });
  });
  test("a Correlator hop record logged through OpenTelemetry is kept as written", () => {
    const hop = `trace_id=${TRACE} hop=in hop_id=${SPAN} parent_id=b7ad6b7169203331 service=shop-api via=http method=GET op=/x`;
    expect(lineOf({ timeNs: null, severityNumber: 9, severityText: "", body: hop, attributes: {}, traceId: TRACE, spanId: SPAN })).toBe(hop);
  });
  test("service and host from the resource; record times kept inside the window, else receive time", () => {
    const res = decodeRequest(protobufBody(), OtlpContentType.Protobuf);
    const [line] = toIntakeLines(res, NOW);
    expect(line).toMatchObject({ service: "shop-api", host: "web-1", timeNs: T1 });
    const old = toIntakeLines([{ ...res[0], records: [{ ...res[0].records[0], timeNs: NOW - TIME_WINDOW_NS.past - 1n }] }], NOW);
    expect(old[0].timeNs).toBeNull();
    const streams = linesToStreams(toIntakeLines(res, NOW), { service: null, host: null }, NOW);
    expect(streams[0].stream).toEqual({ service: "shop-api", source: "shop-api", host: "web-1" });
    expect(streams[0].values[0][0]).toBe(String(T1));
  });
});
