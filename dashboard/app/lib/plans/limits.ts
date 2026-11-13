// What a plan lets an organisation keep. Pure: no database or Loki here.
// Numbers come from the public plan table (components/site/plans.ts), so the pricing page
// and the enforcement never disagree.
//
// A capped plan (Free, or any org with an override) keeps a rolling window: the newest
// `maxRequests` traced requests and `maxBytes` of data. Collection never stops; when new data
// arrives the oldest is discarded (lib/plans/window.ts decides where, retention.server.ts deletes).
import { PLANS, PlanId } from "~/components/site/plans";

/** The plan value of an organisation that is not metered (backwork's own and internal orgs). */
export const UNMETERED = "unmetered";

const GIB = 1024 ** 3;

/** The plan columns of an organisation row. */
export interface OrgPlanRow {
  plan: string;
  /** Overrides the plan's cap on traced requests held. */
  requestsLimit: number | null;
  /** Overrides the plan's cap on bytes held. */
  storageLimitBytes: number | null;
}

export interface Limits {
  plan: PlanId | typeof UNMETERED;
  /** Newest traced requests kept; null is no cap. */
  maxRequests: number | null;
  /** Bytes kept; null is no cap. */
  maxBytes: number | null;
  /** Days hop records are kept; null keeps them for the stack's own retention. */
  hopDays: number | null;
  logDays: number | null;
}

function isPlanId(v: string): v is PlanId {
  return (Object.values(PlanId) as string[]).includes(v);
}

/** True when the organisation holds a rolling window rather than everything. */
export function isCapped(l: Limits): boolean {
  return l.maxRequests !== null || l.maxBytes !== null;
}

/** Limits of an organisation, or null when it is not limited (unknown plan values are not limited). */
export function limitsFor(row: OrgPlanRow): Limits | null {
  if (!isPlanId(row.plan)) return null;
  const plan = PLANS.find((p) => p.id === row.plan);
  if (!plan) return null;
  const a = plan.allowance;
  const overridden = row.requestsLimit !== null || row.storageLimitBytes !== null;
  // Only Free keeps a window; paid plans keep everything their retention allows and bill the usage.
  const free = a !== null && a.extraPerMillionRequests === null;
  if (!a && !overridden) return null; // Enterprise: priced per customer
  return {
    plan: row.plan,
    maxRequests: row.requestsLimit ?? (free && a ? a.requestsPerMonth : null),
    maxBytes: row.storageLimitBytes ?? (free && a ? Math.round(a.logGbPerMonth * GIB) : null),
    hopDays: plan.retention?.requestPathsDays ?? null,
    logDays: plan.retention?.logLinesDays ?? null,
  };
}
