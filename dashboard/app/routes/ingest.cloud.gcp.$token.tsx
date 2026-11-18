import type { ActionFunctionArgs } from "@remix-run/node";
import { startBackgroundJobs } from "~/lib/jobs.server";
import { entriesToLines } from "~/lib/ingest/drains/entry.server";
import { logEntryToEntry, readPush } from "~/lib/ingest/cloud/gcp.server";
import { IntakeStatus, intakeStreams } from "~/lib/ingest/records-intake.server";
import { linesToStreams, originFrom, readBody } from "~/lib/ingest/records.server";
import { resolveIngestToken } from "~/lib/tenant.server";

const FALLBACK_SERVICE = "gcp";

// POST /ingest/cloud/gcp/:token (BAC-99): a Pub/Sub push subscription on the topic a Cloud
// Logging sink writes to. The token is the last path segment (push subscriptions cannot set
// headers; Authorization carries Google's OIDC token when push auth is on, and is ignored).
// 204 acknowledges (stored, or a message that is not a log entry: redelivering it would not help);
// 401 and 502 are redelivered by Pub/Sub; 413 over the size limit.
export async function action({ request, params }: ActionFunctionArgs): Promise<Response> {
  if (request.method !== "POST") return text(405, "method not allowed");
  const tenant = await resolveIngestToken((params.token ?? "").trim());
  if (!tenant) return text(401, "unauthorized");
  startBackgroundJobs();

  const body = await readBody(request);
  if (!body.ok) return text(body.status, body.reason);
  const read = readPush(body.bytes.toString("utf8"));
  if (!read.ok || read.message.entry === null) return ack();
  const entry = logEntryToEntry(read.message.entry, read.message.attributes);
  if (!entry) return ack();
  const nowNs = BigInt(Date.now()) * 1_000_000n;
  const lines = entriesToLines([entry], originFrom(new URL(request.url), request.headers), FALLBACK_SERVICE);
  if (lines.length === 0) return ack();
  const outcome = await intakeStreams(tenant, linesToStreams(lines, { service: null, host: null }, nowNs));
  if (outcome.status === IntakeStatus.CollectorFailed) return text(502, `ingest backend error: ${outcome.reason ?? "collector failed"}`);
  return ack();
}

export function loader(): Response {
  return text(405, "POST Pub/Sub push deliveries of Cloud Logging entries");
}

function ack(): Response {
  return new Response(null, { status: 204 });
}

function text(status: number, body: string): Response {
  return new Response(body, { status, headers: { "content-type": "text/plain" } });
}
