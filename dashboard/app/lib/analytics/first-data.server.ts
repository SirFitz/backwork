// The first time a project receives lines is the value moment of backwork (BAC-103). `projects.first_data_at`
// remembers it, so the fact is sent once per project, across restarts. Projects older than a week when this
// shipped (or first heard from long after they were made) are stamped without an event, so old projects do
// not read as new activations.
import { and, eq, isNull } from "drizzle-orm";
import { db } from "~/db/index.server";
import { projects } from "~/db/schema";
import type { IngestTenant } from "~/lib/ingest/stored.server";
import { analyticsConfig } from "./config.server";
import { FirstDataAge, ServerEvent } from "./events";
import { trackServer } from "./server.server";

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;

/** The time-to-value bucket for a project made `ageMs` ago, or null when it is too old to count as an activation. */
export function firstDataAge(ageMs: number): FirstDataAge | null {
  if (ageMs < HOUR_MS) return FirstDataAge.UnderHour;
  if (ageMs < DAY_MS) return FirstDataAge.UnderDay;
  if (ageMs < WEEK_MS) return FirstDataAge.UnderWeek;
  return null;
}

/** Projects already known to have data in this process: the common ingest costs no query. */
const known = new Set<string>();

/** Called after lines were stored. Never throws and never blocks the ingest. */
export async function noteDataStored(tenant: Pick<IngestTenant, "projectId">, now: Date = new Date()): Promise<void> {
  const projectId = tenant.projectId;
  if (!projectId || known.has(projectId) || !analyticsConfig()?.secretKey) return;
  try {
    // One atomic stamp: only the call that flips NULL to now() sees a row back.
    const stamped = await db
      .update(projects)
      .set({ firstDataAt: now })
      .where(and(eq(projects.id, projectId), isNull(projects.firstDataAt)))
      .returning({ createdAt: projects.createdAt });
    known.add(projectId);
    const created = stamped[0]?.createdAt;
    if (!created) return;
    const after = firstDataAge(now.getTime() - created.getTime());
    if (after) trackServer(ServerEvent.FirstDataReceived, { after }, { dedupeKey: projectId });
  } catch {
    // analytics must never break ingest
  }
}
