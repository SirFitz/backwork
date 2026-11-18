import type { ActionFunctionArgs } from "@remix-run/node";
import { startBackgroundJobs } from "~/lib/jobs.server";
import { entriesToLines } from "~/lib/ingest/drains/entry.server";
import {
  FIREHOSE_MAX_BODY_BYTES,
  FirehoseHeader,
  alreadyStored,
  commonAttributes,
  firehoseEntries,
  firehoseResponse,
  markStored,
  readFirehoseRequest,
} from "~/lib/ingest/cloud/firehose.server";
import { IntakeStatus, intakeLines } from "~/lib/ingest/records-intake.server";
import { BodyError, MAX_LINES, originFrom, readBody } from "~/lib/ingest/records.server";
import { resolveIngestToken } from "~/lib/tenant.server";

/** Most lines one Firehose request may carry (stored in batches of MAX_LINES). */
const FIREHOSE_MAX_LINES = 5 * MAX_LINES;
const FALLBACK_SERVICE = "cloudwatch";

// POST /ingest/cloud/aws/firehose (BAC-99): Amazon Data Firehose HTTP endpoint destination fed
// by CloudWatch Logs subscription filters. Token = X-Amz-Firehose-Access-Key. Every answer is the
// spec's JSON ({requestId, timestamp[, errorMessage]}); 200 only when stored (or a control
// message / a request ID already stored); 413 (permanent for Firehose) over the size limits.
export async function action({ request }: ActionFunctionArgs): Promise<Response> {
  const headerId = request.headers.get(FirehoseHeader.RequestId) ?? "";
  if (request.method !== "POST") return firehoseResponse(405, headerId, "method not allowed");
  const tenant = await resolveIngestToken((request.headers.get(FirehoseHeader.AccessKey) ?? "").trim());
  if (!tenant) return firehoseResponse(401, headerId, "invalid access key: use the backwork project ingest token");
  startBackgroundJobs();

  const body = await readBody(request, FIREHOSE_MAX_BODY_BYTES);
  if (!body.ok) return firehoseResponse(body.status === BodyError.TooLarge ? 413 : 400, headerId, body.reason);
  const read = readFirehoseRequest(body.bytes.toString("utf8"), headerId);
  if (!read.ok) return firehoseResponse(400, read.requestId, read.reason);
  const { requestId, records } = read.request;
  const dedupeKey = `${tenant.projectId}:${requestId}`;
  if (requestId !== "" && alreadyStored(dedupeKey)) return firehoseResponse(200, requestId);

  const parsed = firehoseEntries(records, commonAttributes(request.headers.get(FirehoseHeader.CommonAttributes)));
  if (parsed === null) return firehoseResponse(413, requestId, "records are corrupt gzip or unpack over the size limit");
  const lines = entriesToLines(parsed.entries, originFrom(new URL(request.url), request.headers), FALLBACK_SERVICE);
  if (lines.length > FIREHOSE_MAX_LINES) return firehoseResponse(413, requestId, `more than ${FIREHOSE_MAX_LINES} log events in one request: lower the buffer size`);
  if (lines.length > 0) {
    const outcome = await intakeLines(tenant, lines, BigInt(Date.now()) * 1_000_000n);
    if (outcome.status === IntakeStatus.CollectorFailed) return firehoseResponse(500, requestId, `ingest backend error: ${outcome.reason ?? "collector failed"}`);
  }
  if (requestId !== "") markStored(dedupeKey);
  return firehoseResponse(200, requestId);
}

export function loader(): Response {
  return firehoseResponse(405, "", "POST Amazon Data Firehose HTTP endpoint deliveries");
}
