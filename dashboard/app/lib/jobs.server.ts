// Background jobs, started from one place (BAC-67). Before this the alert evaluator started on
// the first page render and the plan jobs on the first agent push, so a process that only served
// one kind of traffic never ran the other. Both entry points (the root loader and the Loki push
// route) now call `startBackgroundJobs()`, which starts every job once per process.
//
// Each job keeps its own schedule and its own `globalThis` guard; timers are `unref()`ed so they
// never hold the process open. Anything that sends or fires must claim a Postgres row first
// (alert_state, digest_runs): this guard is per process, not per deployment.

import { ensureEvaluator } from "~/lib/evaluator.server";
import { startPlanJobs } from "~/lib/plans/retention.server";

/** The jobs started here. Feature 10 adds the weekly digest. */
export const JobName = {
  AlertEvaluator: "alert_evaluator",
  PlanJobs: "plan_jobs",
} as const;
export type JobName = (typeof JobName)[keyof typeof JobName];

export interface BackgroundJob {
  name: JobName;
  /** Starts the job's timers; must be safe to call more than once. */
  start: () => void;
}

export const BACKGROUND_JOBS: readonly BackgroundJob[] = [
  { name: JobName.AlertEvaluator, start: ensureEvaluator },
  { name: JobName.PlanJobs, start: startPlanJobs },
];

/** Start each job, so that one that throws does not stop the others. Returns the names started. */
export function startJobs(jobs: readonly BackgroundJob[]): JobName[] {
  const started: JobName[] = [];
  for (const job of jobs) {
    try {
      job.start();
      started.push(job.name);
    } catch (e: unknown) {
      console.error(JSON.stringify({ msg: "background job failed to start", job: job.name, error: e instanceof Error ? e.message : String(e) }));
    }
  }
  return started;
}

declare global {
  // eslint-disable-next-line no-var
  var __bwBackgroundJobs: boolean | undefined;
}

/** Start every background job once per process. Safe to call on every request. */
export function startBackgroundJobs(jobs: readonly BackgroundJob[] = BACKGROUND_JOBS): void {
  if (globalThis.__bwBackgroundJobs) return;
  globalThis.__bwBackgroundJobs = true;
  startJobs(jobs);
}
