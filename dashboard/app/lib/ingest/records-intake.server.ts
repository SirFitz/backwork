/**
 * The records intake's I/O (BAC-96): the project's switches, filter, excluded paths and service
 * names, the enforcement pass every agent push gets, then the stack collector's `records` input,
 * which stores and counts the lines with the collectors' own transforms. Shared by
 * POST /ingest/records and POST /ingest/otlp/v1/logs.
 */
import { config } from "~/lib/config.server";
import { getCompiledFilter, getControls } from "~/lib/controls.server";
import { getExcludedPathMatcher } from "~/lib/excluded-paths.server";
import { enforceStreams, streamSwitches, type EnforceContext, type LokiStream } from "~/lib/ingest/enforce.server";
import { MAX_LINES, linesToStreams, toNdjson, toRecordEvents, type IntakeLine } from "~/lib/ingest/records.server";
import { afterStored, type IngestTenant } from "~/lib/ingest/stored.server";
import { serviceNamesWithin } from "~/lib/service-names.server";
import { tenantOf } from "~/lib/tenant.server";

const COLLECTOR_TIMEOUT_MS = 10_000;

export const IntakeStatus = { Stored: "stored", NothingKept: "nothing_kept", CollectorFailed: "collector_failed" } as const;
export type IntakeStatus = (typeof IntakeStatus)[keyof typeof IntakeStatus];

export interface IntakeOutcome {
  status: IntakeStatus;
  /** Lines stored. */
  accepted: number;
  /** Lines the switches or excluded paths left out. */
  dropped: number;
  /** Why the collector refused, for CollectorFailed. */
  reason?: string;
}

/** Posts NDJSON to the collector; resolves to null on success or the failure reason. */
export type CollectorPost = (body: string) => Promise<string | null>;

export const postToCollector: CollectorPost = async (body) => {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), COLLECTOR_TIMEOUT_MS);
  try {
    const res = await fetch(config.recordsCollectorUrl, {
      method: "POST",
      headers: { "content-type": "application/x-ndjson" },
      body,
      signal: ctrl.signal,
    });
    if (res.ok) return null;
    return `collector answered ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`;
  } catch (e: unknown) {
    return `collector unreachable: ${e instanceof Error ? e.message : String(e)}`;
  } finally {
    clearTimeout(timer);
  }
};

/** Enforce and store streams of posted lines for one tenant. */
export async function intakeStreams(tenant: IngestTenant, streams: readonly LokiStream[], post: CollectorPost = postToCollector): Promise<IntakeOutcome> {
  const [rows, filter, names, excluded] = await Promise.all([
    getControls(tenant.orgId),
    getCompiledFilter(tenant.orgId),
    serviceNamesWithin(tenantOf(tenant.orgId), 1500),
    getExcludedPathMatcher(tenant.orgId, tenant.projectId),
  ]);
  const ctx: EnforceContext = { projectId: tenant.projectId, rows, filter, serviceOf: names.bySource, excluded, deriveErrors: true };
  const result = enforceStreams(streams, ctx);
  if (result.kept === 0) return { status: IntakeStatus.NothingKept, accepted: 0, dropped: result.dropped };
  const events = toRecordEvents(result.streams, tenant, (labels) => streamSwitches(labels, ctx).on);
  const failed = await post(toNdjson(events));
  if (failed !== null) return { status: IntakeStatus.CollectorFailed, accepted: 0, dropped: result.dropped, reason: failed };
  await afterStored(tenant, result);
  return { status: IntakeStatus.Stored, accepted: result.kept, dropped: result.dropped };
}

/** The HTTP answer for an outcome: 200 with counts, 502 when the collector failed. */
export function outcomeResponse(o: IntakeOutcome): Response {
  if (o.status === IntakeStatus.CollectorFailed) {
    return new Response(`ingest backend error: ${o.reason ?? "collector failed"}`, { status: 502, headers: { "content-type": "text/plain" } });
  }
  return new Response(JSON.stringify({ accepted: o.accepted, dropped: o.dropped }), { status: 200, headers: { "content-type": "application/json" } });
}

/**
 * Intake lines in batches of at most MAX_LINES (BAC-99), for senders whose one request can carry
 * more (a Firehose batch). Stops at the first collector failure: earlier batches stay stored, so
 * a retried request can repeat them.
 */
export async function intakeLines(
  tenant: IngestTenant,
  lines: readonly IntakeLine[],
  nowNs: bigint,
  store: (streams: LokiStream[]) => Promise<IntakeOutcome> = (streams) => intakeStreams(tenant, streams),
): Promise<IntakeOutcome> {
  const total: IntakeOutcome = { status: IntakeStatus.NothingKept, accepted: 0, dropped: 0 };
  for (let i = 0; i < lines.length; i += MAX_LINES) {
    const o = await store(linesToStreams(lines.slice(i, i + MAX_LINES), { service: null, host: null }, nowNs + BigInt(i)));
    total.dropped += o.dropped;
    if (o.status === IntakeStatus.CollectorFailed) return { ...total, status: IntakeStatus.CollectorFailed, reason: o.reason };
    total.accepted += o.accepted;
    if (o.status === IntakeStatus.Stored) total.status = IntakeStatus.Stored;
  }
  return total;
}
