import type { ActionFunctionArgs } from "@remix-run/node";
import { startBackgroundJobs } from "~/lib/jobs.server";
import { DRAIN_PARSERS, emptyAnswer, fallbackService } from "~/lib/ingest/drains/index.server";
import { entriesToLines, unpacked } from "~/lib/ingest/drains/entry.server";
import { drainPlatformOf } from "~/lib/ingest/drains/platforms";
import { IntakeStatus, intakeStreams, outcomeResponse } from "~/lib/ingest/records-intake.server";
import { MAX_LINES, linesToStreams, originFrom, readBody, tokenFrom } from "~/lib/ingest/records.server";
import { resolveIngestToken } from "~/lib/tenant.server";

// POST /ingest/drains/:platform (BAC-98): a platform's own log drain (Vercel, Heroku, Fly's log
// shipper, Cloudflare Logpush) posting its native payload with the project ingest token as a
// header (Bearer, or Basic from the drain URL for Heroku). Each platform's parser maps service,
// host, level and time from the platform's metadata, then the lines go through the records
// intake (BAC-96): switches, filter, hop detection, Loki, metrics. 200 {accepted, dropped}
// (empty for Heroku), 400 unreadable, 401, 404 unknown platform, 413, 502 store down.
export async function action({ request, params }: ActionFunctionArgs): Promise<Response> {
  const platform = drainPlatformOf(params.platform);
  if (!platform) return text(404, "unknown platform");
  if (request.method !== "POST") return text(405, "method not allowed");
  const tenant = await resolveIngestToken(tokenFrom(request.headers));
  if (!tenant) return text(401, "unauthorized");
  startBackgroundJobs();

  const body = await readBody(request);
  if (!body.ok) return text(body.status, body.reason);
  const bytes = unpacked(body.bytes);
  if (bytes === null) return text(413, "gzip body is corrupt or over the size limit unpacked");
  const result = DRAIN_PARSERS[platform](bytes, request.headers);
  if (!result.ok) return text(400, result.reason);

  const done = (accepted: number, dropped: number): Response =>
    emptyAnswer(platform)
      ? new Response(null, { status: 200, headers: { "content-length": "0" } })
      : new Response(JSON.stringify({ accepted, dropped }), { status: 200, headers: { "content-type": "application/json" } });
  if (result.test) return done(0, 0);

  const lines = entriesToLines(result.entries, originFrom(new URL(request.url), request.headers), fallbackService(platform));
  if (lines.length > MAX_LINES) return text(413, `more than ${MAX_LINES} lines in one post`);
  if (lines.length === 0) return done(0, 0);
  const nowNs = BigInt(Date.now()) * 1_000_000n;
  const outcome = await intakeStreams(tenant, linesToStreams(lines, { service: null, host: null }, nowNs));
  if (outcome.status === IntakeStatus.CollectorFailed) return outcomeResponse(outcome);
  return done(outcome.accepted, outcome.dropped);
}

export function loader(): Response {
  return text(405, "POST a platform log drain (vercel, heroku, fly, cloudflare) with a project ingest token");
}

function text(status: number, body: string): Response {
  return new Response(body, { status, headers: { "content-type": "text/plain" } });
}
