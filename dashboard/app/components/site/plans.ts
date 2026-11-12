// Plans and usage pricing for the public site. One definition, read by the pricing page,
// its estimator and the landing page. Prices are in US dollars.

export enum PlanId {
  Free = "free",
  Team = "team",
  Business = "business",
  Enterprise = "enterprise",
}

export enum Billing {
  Monthly = "monthly",
  Yearly = "yearly",
}

/** What a plan includes each month, and what more costs. `null` extra prices mean
 *  collection pauses at the limit and the plan is never billed for more. */
export interface Allowance {
  requestsPerMonth: number;
  logGbPerMonth: number;
  extraPerMillionRequests: number | null;
  extraPerGb: number | null;
}

export interface Retention {
  requestPathsDays: number;
  logLinesDays: number;
}

export interface Plan {
  id: PlanId;
  name: string;
  monthlyPrice: number | null; // null: priced per customer
  tagline: string;
  allowance: Allowance | null;
  retention: Retention | null;
  cta: { label: string; href: string };
  features: string[];
  featured?: boolean;
  badge?: string;
}

const YEARLY_MONTHS_CHARGED = 10; // pay yearly: two months free

export const PLANS: readonly Plan[] = [
  {
    id: PlanId.Free,
    name: "Free",
    monthlyPrice: 0,
    tagline: "For a first look. Collection pauses at the limit, and Free is never billed.",
    allowance: { requestsPerMonth: 100_000, logGbPerMonth: 1, extraPerMillionRequests: null, extraPerGb: null },
    retention: { requestPathsDays: 3, logLinesDays: 3 },
    cta: { label: "Start free", href: "/register" },
    features: ["1 project, 3 people", "Performance and log search", "Sensitive-data filter", "Email alerts"],
  },
  {
    id: PlanId.Team,
    name: "Team",
    monthlyPrice: 29,
    tagline: "For a team whose customers depend on it.",
    allowance: { requestsPerMonth: 2_000_000, logGbPerMonth: 20, extraPerMillionRequests: 10, extraPerGb: 0.5 },
    retention: { requestPathsDays: 30, logLinesDays: 14 },
    cta: { label: "Start 14-day trial", href: "/register?plan=team" },
    features: ["Unlimited people and projects", "Switches per project and service", "Slack, Discord and webhook alerts", "Email support"],
    featured: true,
    badge: "Most teams",
  },
  {
    id: PlanId.Business,
    name: "Business",
    monthlyPrice: 99,
    tagline: "For several products, teams or clients.",
    allowance: { requestsPerMonth: 10_000_000, logGbPerMonth: 100, extraPerMillionRequests: 8, extraPerGb: 0.4 },
    retention: { requestPathsDays: 90, logLinesDays: 30 },
    cta: { label: "Start 14-day trial", href: "/register?plan=business" },
    features: ["Several organisations", "Single sign-on", "Audit log", "Priority support"],
  },
  {
    id: PlanId.Enterprise,
    name: "Enterprise",
    monthlyPrice: null,
    tagline: "For a data region of your own, longer retention or an uptime promise.",
    allowance: null,
    retention: null,
    cta: { label: "Talk to us", href: "mailto:hello@backwork.dev?subject=backwork%20Enterprise" },
    features: ["Volume to suit you", "Choice of data region", "Retention to suit you", "Uptime SLA", "Invoiced billing", "Help moving from your current tool"],
  },
];

export const EVERY_PLAN = ["Request view", "Performance", "Log search", "Errors", "Alerts", "Sensitive-data filter"] as const;

export function planById(id: PlanId): Plan {
  const plan = PLANS.find((p) => p.id === id);
  if (!plan) throw new Error(`unknown plan ${id}`);
  return plan;
}

export function priceFor(plan: Plan, billing: Billing): number | null {
  if (plan.monthlyPrice === null) return null;
  return billing === Billing.Yearly ? plan.monthlyPrice * YEARLY_MONTHS_CHARGED : plan.monthlyPrice;
}

export function formatRequests(n: number): string {
  if (n >= 1_000_000) return `${+(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${+(n / 1_000).toFixed(1)}k`;
  return String(n);
}

export function formatMoney(n: number): string {
  return Number.isInteger(n) ? `$${n.toLocaleString("en-US")}` : `$${n.toFixed(2)}`;
}

export interface Estimate {
  plan: Plan;
  total: number;
  extraRequests: number;
  extraGb: number;
  breakdown: string;
}

/** Monthly cost of a usage level on one plan. Free is never billed, so it only fits when under both limits. */
export function estimateOn(plan: Plan, requestsPerMonth: number, logGbPerMonth: number): Estimate | null {
  const a = plan.allowance;
  if (!a || plan.monthlyPrice === null) return null;
  const extraRequests = Math.max(0, requestsPerMonth - a.requestsPerMonth);
  const extraGb = Math.max(0, logGbPerMonth - a.logGbPerMonth);
  if (a.extraPerMillionRequests === null || a.extraPerGb === null) {
    return extraRequests > 0 || extraGb > 0 ? null : { plan, total: 0, extraRequests: 0, extraGb: 0, breakdown: "Inside the free allowance" };
  }
  const total = plan.monthlyPrice + (extraRequests / 1_000_000) * a.extraPerMillionRequests + extraGb * a.extraPerGb;
  const parts = [formatMoney(plan.monthlyPrice)];
  if (extraRequests > 0) parts.push(`${formatRequests(extraRequests)} requests × ${formatMoney(a.extraPerMillionRequests)}/M`);
  if (extraGb > 0) parts.push(`${+extraGb.toFixed(1)} GB × ${formatMoney(a.extraPerGb)}`);
  return { plan, total: Math.round(total * 100) / 100, extraRequests, extraGb, breakdown: parts.join(" + ") };
}

/** The cheapest plan for a usage level, among the self-serve plans. */
export function cheapest(requestsPerMonth: number, logGbPerMonth: number): Estimate {
  const options = PLANS.map((p) => estimateOn(p, requestsPerMonth, logGbPerMonth)).filter((e): e is Estimate => e !== null);
  return options.reduce((best, e) => (e.total < best.total ? e : best));
}
