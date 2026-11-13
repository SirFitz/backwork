// What a plan lets an organisation collect each month. Pure: no database or Loki here.
// Numbers come from the public plan table (components/site/plans.ts), so the pricing page
// and the enforcement never disagree.
import { PLANS, PlanId } from "~/components/site/plans";

/** The plan value of an organisation that is not metered (backwork's own and internal orgs). */
export const UNMETERED = "unmetered";

const GIB = 1024 ** 3;

/** The plan columns of an organisation row. */
export interface OrgPlanRow {
  plan: string;
  /** Overrides the plan's requests per month. A set override is always a hard cap. */
  requestsLimit: number | null;
  /** Overrides the plan's storage. A set override is always a hard cap. */
  storageLimitBytes: number | null;
}

export interface Limits {
  plan: PlanId | typeof UNMETERED;
  requestsPerMonth: number | null;
  storageBytes: number | null;
  /** True: collection pauses at the limit (Free). False: usage goes on and is billed (paid plans). */
  pauseAtLimit: boolean;
  /** Days hop records are kept; null keeps them for the stack's own retention. */
  hopDays: number | null;
  logDays: number | null;
}

export const PausedBecause = { Requests: "requests", Storage: "storage" } as const;
export type PausedBecause = (typeof PausedBecause)[keyof typeof PausedBecause];

export interface Usage {
  requests: number;
  bytes: number;
}

function isPlanId(v: string): v is PlanId {
  return (Object.values(PlanId) as string[]).includes(v);
}

/** Limits of an organisation, or null when it is not metered (unknown plan values are not metered). */
export function limitsFor(row: OrgPlanRow): Limits | null {
  if (!isPlanId(row.plan)) return null;
  const plan = PLANS.find((p) => p.id === row.plan);
  if (!plan) return null;
  const a = plan.allowance;
  if (!a && row.requestsLimit === null && row.storageLimitBytes === null) return null; // Enterprise: priced per customer
  const overridden = row.requestsLimit !== null || row.storageLimitBytes !== null;
  return {
    plan: row.plan,
    requestsPerMonth: row.requestsLimit ?? a?.requestsPerMonth ?? null,
    storageBytes: row.storageLimitBytes ?? (a ? Math.round(a.logGbPerMonth * GIB) : null),
    pauseAtLimit: overridden || (a !== null && a.extraPerMillionRequests === null),
    hopDays: plan.retention?.requestPathsDays ?? null,
    logDays: plan.retention?.logLinesDays ?? null,
  };
}

/** The billing month an instant falls in, UTC, as YYYY-MM. */
export function currentPeriod(at: Date = new Date()): string {
  return at.toISOString().slice(0, 7);
}

/** Why collection is paused, or null when it is not. Only a plan that pauses can pause. */
export function pausedReason(limits: Limits, usage: Usage): PausedBecause | null {
  if (!limits.pauseAtLimit) return null;
  if (limits.requestsPerMonth !== null && usage.requests >= limits.requestsPerMonth) return PausedBecause.Requests;
  if (limits.storageBytes !== null && usage.bytes >= limits.storageBytes) return PausedBecause.Storage;
  return null;
}
