// The words of an alert (BAC-72): the notification each channel gets and the "Right now" line of
// the New rule form. Pure. Copy rules: plain, units always shown, no em dashes, British spelling.

import { shapeLabel } from "./hops/stmt-shape";
import { markerLabel, type Deploy } from "./deploys";
import { AlertNotify } from "./alert-decision";
import { ROUTE_WINDOW_TEXT, AlertMetric, METRIC_META, isAlertMetric, type AlertRule } from "./alert-kinds";
import { ruleWindow, type RuleReading } from "./alert-queries";

/** A deploy older than this is not mentioned in a message. */
export const DEPLOY_MENTION_MS = 24 * 60 * 60_000;
/** The slow queries board reads one hour. */
const BOARD_WINDOW_TEXT = "the last hour";

export interface AlertMessage {
  title: string;
  body: string;
  /** A page to open, for the channels that show a link. */
  link: string | null;
}

/** A count as people write it: 1,820. */
export function fmtCount(n: number): string {
  return Math.round(n).toLocaleString("en-GB");
}

/** Milliseconds, rounded: 740 ms, 2.4 ms, 1,250 ms. */
export function fmtAlertMs(ms: number): string {
  return ms < 10 ? `${(Math.round(ms * 10) / 10).toString()} ms` : `${fmtCount(ms)} ms`;
}

/** A percent with at most one decimal: 7.2 percent. */
export function fmtPercent(p: number): string {
  return `${(Math.round(p * 10) / 10).toString()} percent`;
}

/** The value of a reading in the rule's unit, as a message says it. */
export function fmtRuleValue(metric: AlertMetric, v: number): string {
  switch (metric) {
    case AlertMetric.RouteP95:
    case AlertMetric.SlowQuery:
      return fmtAlertMs(v);
    case AlertMetric.RouteErrorRate:
      return fmtPercent(v);
    case AlertMetric.ErrorRate:
    case AlertMetric.LogRate:
      return `${v.toFixed(2)}${METRIC_META[metric].unit}`;
  }
}

/** "22 minutes ago", "3 hours ago", "just now". */
export function fmtAgo(ms: number): string {
  const min = Math.floor(ms / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} minute${min === 1 ? "" : "s"} ago`;
  const h = Math.floor(min / 60);
  return `${h} hour${h === 1 ? "" : "s"} ago`;
}

function routeName(rule: AlertRule): string {
  const r = rule.route;
  if (!r) return rule.service;
  return `${r.method ? r.method + " " : ""}${r.op} in ${rule.service}`;
}

function deployClause(service: string, deploy: Deploy | null, nowMs: number): string {
  if (!deploy || nowMs - deploy.deployedAt > DEPLOY_MENTION_MS || deploy.deployedAt > nowMs) return "";
  return ` Last deploy of ${service}: ${fmtAgo(nowMs - deploy.deployedAt)} (${markerLabel(deploy)}).`;
}

/** The link a message carries: Performance for a route, the board for a query. */
export function alertLink(rule: AlertRule, reading: RuleReading, publicUrl: string): string | null {
  const base = publicUrl.replace(/\/+$/, "");
  if (rule.metric === AlertMetric.RouteP95 || rule.metric === AlertMetric.RouteErrorRate) {
    return `${base}/performance?service=${encodeURIComponent(rule.service)}`;
  }
  if (rule.metric === AlertMetric.SlowQuery) {
    const q = reading.query;
    return q ? `${base}/insights/queries?open=${encodeURIComponent(`${q.service}:${q.shapeId}`)}` : `${base}/insights/queries`;
  }
  return null;
}

/** The sentence that states the reading, shared by notifications and the form preview. */
function readingSentence(metric: AlertMetric, reading: RuleReading): string {
  const v = fmtRuleValue(metric, reading.value);
  switch (metric) {
    case AlertMetric.RouteP95:
      return `p95 is ${v}`;
    case AlertMetric.RouteErrorRate:
      return `errors are ${v} of requests`;
    case AlertMetric.SlowQuery:
      return `p95 is ${v}`;
    case AlertMetric.ErrorRate:
    case AlertMetric.LogRate:
      return `${METRIC_META[metric].label} is ${v}`;
  }
}

/**
 * The notification of one transition.
 * Firing: "GET /checkout in checkout-api: p95 is 740 ms (limit 500 ms) over the last 15 minutes,
 * 1,820 requests. Last deploy of checkout-api: 22 minutes ago (v1.4.2)."
 */
export function alertMessage(
  rule: AlertRule,
  reading: RuleReading,
  kind: AlertNotify,
  deploy: Deploy | null,
  nowMs: number,
  publicUrl: string,
): AlertMessage {
  const title = kind === AlertNotify.Firing ? `FIRING: ${rule.name}` : `RESOLVED: ${rule.name}`;
  if (!isAlertMetric(rule.metric)) return { title, body: rule.name, link: null };
  const metric = rule.metric;
  const meta = METRIC_META[metric];
  const limit = metric === AlertMetric.ErrorRate || metric === AlertMetric.LogRate ? `${rule.threshold}${meta.unit}` : fmtRuleValue(metric, rule.threshold);
  const link = alertLink(rule, reading, publicUrl);
  const state = kind === AlertNotify.Firing ? `(limit ${limit})` : `(back ${rule.comparator === ">" ? "under" : "over"} ${limit})`;
  if (metric === AlertMetric.ErrorRate || metric === AlertMetric.LogRate) {
    const scope = rule.service === "*" ? "any service" : rule.service;
    return { title, body: `${scope}: ${meta.label} ${rule.comparator} ${limit} (currently ${fmtRuleValue(metric, reading.value)})`, link };
  }
  if (metric === AlertMetric.SlowQuery) {
    const q = reading.query;
    const who = q ? `${shapeLabel(q.shape)} in ${q.service}` : rule.service === "*" ? "Slowest query" : `Slowest query in ${rule.service}`;
    const calls = q ? `, ${fmtCount(q.calls)} call${q.calls === 1 ? "" : "s"}` : "";
    return { title, body: `${who}: ${readingSentence(metric, reading)} ${state} over ${BOARD_WINDOW_TEXT}${calls}.${q ? deployClause(q.service, deploy, nowMs) : ""}`, link };
  }
  const requests = reading.requests !== undefined ? `, ${fmtCount(reading.requests)} request${reading.requests === 1 ? "" : "s"}` : "";
  const body = `${routeName(rule)}: ${readingSentence(metric, reading)} ${state} over ${ROUTE_WINDOW_TEXT[ruleWindow(rule)]}${requests}.${deployClause(rule.service, deploy, nowMs)}`;
  return { title, body, link };
}

/** The "Right now" line of the New rule form: "Right now: p95 is 412 ms (1,240 requests)." */
export function previewLine(rule: AlertRule, reading: RuleReading): string {
  if (!isAlertMetric(rule.metric)) return "This kind can no longer be checked.";
  const metric = rule.metric;
  if (reading.noData) {
    if (reading.requests !== undefined) {
      return `Right now: not enough requests to judge (${fmtCount(reading.requests)} in ${ROUTE_WINDOW_TEXT[ruleWindow(rule)]}).`;
    }
    return metric === AlertMetric.SlowQuery ? "Right now: no query with enough calls in the last hour." : "Right now: no data.";
  }
  const sentence = readingSentence(metric, reading);
  if (reading.requests !== undefined) return `Right now: ${sentence} (${fmtCount(reading.requests)} requests).`;
  if (reading.query) return `Right now: ${sentence} (${fmtCount(reading.query.calls)} calls, ${shapeLabel(reading.query.shape, 48)}).`;
  return `Right now: ${sentence}.`;
}
