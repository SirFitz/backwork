import type { ActionFunctionArgs } from "@remix-run/node";
import { startBackgroundJobs } from "~/lib/jobs.server";
import { IntakeStatus, intakeStreams } from "~/lib/ingest/records-intake.server";
import { MAX_LINES, linesToStreams, originFrom, readBody, tokenFrom, type IntakeLine } from "~/lib/ingest/records.server";
import { OtlpContentType, OtlpFormatError, decodeRequest, otlpContentType, toIntakeLines } from "~/lib/ingest/otlp.server";
import { resolveIngestToken } from "~/lib/tenant.server";

// POST /ingest/otlp/v1/logs (BAC-97): OTLP/HTTP logs, protobuf or JSON, gzip optional. An
// OpenTelemetry SDK needs only env vars:
//   OTEL_EXPORTER_OTLP_LOGS_ENDPOINT=https://backwork.dev/ingest/otlp/v1/logs
//   OTEL_EXPORTER_OTLP_HEADERS=x-backwork-token=<project ingest token>
// service.name and host.name from the resource, severity to level, trace and span IDs kept (the
// line links to its request), then the records intake (BAC-96): switches, filter, Loki, metrics.
// Answers as OTLP/HTTP expects: 200 with an empty ExportLogsServiceResponse, 400 bad request,
// 401, 413, 415, 502 when the store is down (retryable).
export async function action({ request }: ActionFunctionArgs): Promise<Response> {
  if (request.method !== "POST") return text(405, "method not allowed");
  const type = otlpContentType(request.headers.get("content-type"));
  if (!type) return text(415, "send application/x-protobuf or application/json");
  const tenant = await resolveIngestToken(tokenFrom(request.headers));
  if (!tenant) return text(401, "unauthorized");
  startBackgroundJobs();

  const body = await readBody(request);
  if (!body.ok) return text(body.status, body.reason);
  const nowNs = BigInt(Date.now()) * 1_000_000n;
  let lines: IntakeLine[];
  try {
    lines = toIntakeLines(decodeRequest(body.bytes, type), nowNs);
  } catch (e: unknown) {
    if (e instanceof OtlpFormatError) return text(400, e.message);
    throw e;
  }
  if (lines.length > MAX_LINES) return text(413, `more than ${MAX_LINES} log records in one request`);
  if (lines.length > 0) {
    const streams = linesToStreams(lines, originFrom(new URL(request.url), request.headers), nowNs);
    const outcome = await intakeStreams(tenant, streams);
    if (outcome.status === IntakeStatus.CollectorFailed) return text(502, `ingest backend error: ${outcome.reason ?? "collector failed"}`);
  }
  // ExportLogsServiceResponse with no partial_success: empty in both encodings.
  return type === OtlpContentType.Protobuf
    ? new Response(new Uint8Array(0), { status: 200, headers: { "content-type": OtlpContentType.Protobuf } })
    : new Response("{}", { status: 200, headers: { "content-type": OtlpContentType.Json } });
}

export function loader(): Response {
  return text(405, "POST OTLP/HTTP logs (protobuf or JSON) with a project ingest token");
}

function text(status: number, body: string): Response {
  return new Response(body, { status, headers: { "content-type": "text/plain" } });
}
