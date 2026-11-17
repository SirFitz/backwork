/**
 * Fly.io (https://github.com/superfly/fly-log-shipper): Fly has no built-in drain; its log
 * shipper is a Vector app the customer runs in their Fly organisation, reading the org's log
 * stream (NATS) and posting with its HTTP sink (vector-configs/sinks/http.toml: json codec,
 * `Authorization: Bearer $HTTP_TOKEN`). Bodies are a JSON array (Vector's default framing for
 * json) or NDJSON of the stream's events:
 * `{"event":{"provider":"app"},"fly":{"app":{"instance","name"},"region"},"host","log":{"level"},"message","timestamp"}`.
 *
 * service = fly.app.name; host = fly.app.instance (the Machine); level = log.level; time = timestamp.
 */
import { rfc3339Ns } from "~/lib/ingest/records.server";
import { jsonObjects, levelWord, obj, parsed, str, unreadable, type DrainEntry, type DrainParser, type EntryFields } from "./entry.server";

export function flyEntry(o: Record<string, unknown>): DrainEntry | null {
  const message = str(o, "message");
  if (message === null) return null;
  const fly = obj(o, "fly");
  const app = fly ? obj(fly, "app") : null;
  const log = obj(o, "log");
  const ts = str(o, "timestamp");
  const fields: EntryFields = {};
  const region = fly ? str(fly, "region") : null;
  const provider = str(obj(o, "event"), "provider");
  if (region) fields.region = region;
  if (provider) fields.provider = provider;
  return {
    message,
    level: levelWord(log ? str(log, "level") : null),
    service: app ? str(app, "name") : null,
    host: (app ? str(app, "instance") : null) ?? str(o, "host"),
    timeNs: ts ? rfc3339Ns(ts) : null,
    fields,
  };
}

export const parseFly: DrainParser = (body) => {
  const objects = jsonObjects(body.toString("utf8"));
  if (objects === null) return unreadable("body is not a JSON array or NDJSON of Fly log events");
  return parsed(objects.map(flyEntry).filter((e): e is DrainEntry => e !== null));
};
