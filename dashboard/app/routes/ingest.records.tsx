import type { ActionFunctionArgs } from "@remix-run/node";
import { startBackgroundJobs } from "~/lib/jobs.server";
import { intakeStreams, outcomeResponse } from "~/lib/ingest/records-intake.server";
import { MAX_LINES, linesToStreams, originFrom, readBody, splitLines, stampedLine, tokenFrom } from "~/lib/ingest/records.server";
import { resolveIngestToken } from "~/lib/tenant.server";

// POST /ingest/records (BAC-96): hop records, link lines and ordinary log lines posted as
// newline-delimited text (Correlator's CORRELATOR_RECORD_SINK posts exactly this), optionally
// gzip, with a project ingest token. No agent and no change on the customer's host: the lines
// are switched, filtered and stored as if the agent had shipped them, and hop end records feed
// the backwork_hop_* figures. Service and host from x-backwork-service / x-backwork-host or
// ?service= / ?host=. A line may carry its own time as a prefix, `<RFC 3339 or epoch ns>\t<line>`
// (BAC-98, stampedLine); else it is stored at the receive time. 200 {accepted, dropped}; 401 bad
// token; 413 over the size limit.
export async function action({ request }: ActionFunctionArgs): Promise<Response> {
  if (request.method !== "POST") return text(405, "method not allowed");
  const tenant = await resolveIngestToken(tokenFrom(request.headers));
  if (!tenant) return text(401, "unauthorized");
  startBackgroundJobs();

  const body = await readBody(request);
  if (!body.ok) return text(body.status, body.reason);
  const lines = splitLines(body.bytes.toString("utf8"));
  if (lines.length > MAX_LINES) return text(413, `more than ${MAX_LINES} lines in one post`);
  if (lines.length === 0) return new Response(null, { status: 204 });

  const origin = originFrom(new URL(request.url), request.headers);
  const nowNs = BigInt(Date.now()) * 1_000_000n;
  const streams = linesToStreams(lines.map(stampedLine), origin, nowNs);
  return outcomeResponse(await intakeStreams(tenant, streams));
}

export function loader(): Response {
  return text(405, "POST newline-delimited lines with Authorization: Bearer <project ingest token>");
}

function text(status: number, body: string): Response {
  return new Response(body, { status, headers: { "content-type": "text/plain" } });
}
