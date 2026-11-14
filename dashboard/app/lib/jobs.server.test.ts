import { describe, expect, mock, test } from "bun:test";
import { BACKGROUND_JOBS, JobName, startBackgroundJobs, startJobs, type BackgroundJob } from "./jobs.server";

describe("background jobs", () => {
  test("the evaluator, the plan jobs, the automatic pins and the weekly digest are all started from one place", () => {
    expect(BACKGROUND_JOBS.map((j) => j.name)).toEqual([JobName.AlertEvaluator, JobName.PlanJobs, JobName.AutoPins, JobName.WeeklyDigest]);
  });

  test("startBackgroundJobs starts each job once per process", () => {
    const evaluator = mock(() => {});
    const plans = mock(() => {});
    const jobs: BackgroundJob[] = [
      { name: JobName.AlertEvaluator, start: evaluator },
      { name: JobName.PlanJobs, start: plans },
    ];
    const before = globalThis.__bwBackgroundJobs;
    globalThis.__bwBackgroundJobs = undefined;
    try {
      startBackgroundJobs(jobs);
      startBackgroundJobs(jobs);
      expect(evaluator).toHaveBeenCalledTimes(1);
      expect(plans).toHaveBeenCalledTimes(1);
    } finally {
      globalThis.__bwBackgroundJobs = before;
    }
  });

  test("a job that throws does not stop the others", () => {
    const later = mock(() => {});
    const quiet = console.error;
    console.error = () => {};
    try {
      const started = startJobs([
        { name: JobName.AlertEvaluator, start: () => { throw new Error("no database"); } },
        { name: JobName.PlanJobs, start: later },
      ]);
      expect(started).toEqual([JobName.PlanJobs]);
      expect(later).toHaveBeenCalledTimes(1);
    } finally {
      console.error = quiet;
    }
  });
});
