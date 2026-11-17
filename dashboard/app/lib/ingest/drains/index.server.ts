/**
 * Platform log drains (BAC-98): one parser per platform, all feeding the records pipeline
 * (records.server.ts, records-intake.server.ts) so switches, the sensitive-data filter, hop
 * detection and metrics apply unchanged. Route: POST /ingest/drains/<platform>.
 */
import { DrainPlatform } from "./platforms";
import { parseCloudflare } from "./cloudflare.server";
import type { DrainParser } from "./entry.server";
import { parseFly } from "./fly.server";
import { parseHeroku } from "./heroku.server";
import { parseVercel } from "./vercel.server";

export const DRAIN_PARSERS: Readonly<Record<DrainPlatform, DrainParser>> = {
  [DrainPlatform.Vercel]: parseVercel,
  [DrainPlatform.Heroku]: parseHeroku,
  [DrainPlatform.Fly]: parseFly,
  [DrainPlatform.Cloudflare]: parseCloudflare,
};

/** Service for lines whose platform names none and whose drain URL sets no ?service=. */
export function fallbackService(p: DrainPlatform): string {
  return p;
}

/** How each platform wants to be answered: Logplex wants an empty 200 (Content-Length: 0). */
export function emptyAnswer(p: DrainPlatform): boolean {
  return p === DrainPlatform.Heroku;
}
