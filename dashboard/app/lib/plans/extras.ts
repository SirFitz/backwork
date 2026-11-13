// What a month's usage costs beyond a paid plan's allowance, at the rates on the pricing page.
// Pure: the same prices the pricing estimator reads (components/site/plans.ts).
import { formatMoney, formatRequests, type Plan } from "~/components/site/plans";

const GIB = 1024 ** 3;

export interface Extra {
  /** Requests past the allowance. */
  requests: number;
  /** Data past the allowance, in GiB. */
  gb: number;
  /** Cost of both, in US dollars, rounded to cents. */
  cost: number;
  /** For example "128k requests × $10/M + 2.5 GB × $0.50". */
  breakdown: string;
}

/** The extra a plan charges for a month's usage, or null when the plan has no extra prices (Free, Enterprise). */
export function extraFor(plan: Plan, requests: number, bytes: number): Extra | null {
  const a = plan.allowance;
  if (!a || a.extraPerMillionRequests === null || a.extraPerGb === null) return null;
  const extraRequests = Math.max(0, requests - a.requestsPerMonth);
  const extraGb = Math.max(0, bytes / GIB - a.logGbPerMonth);
  const cost = (extraRequests / 1_000_000) * a.extraPerMillionRequests + extraGb * a.extraPerGb;
  const parts: string[] = [];
  if (extraRequests > 0) parts.push(`${formatRequests(Math.round(extraRequests))} requests × ${formatMoney(a.extraPerMillionRequests)}/M`);
  if (extraGb > 0) parts.push(`${+extraGb.toFixed(2)} GB × ${formatMoney(a.extraPerGb)}`);
  return { requests: Math.round(extraRequests), gb: extraGb, cost: Math.round(cost * 100) / 100, breakdown: parts.join(" + ") };
}
