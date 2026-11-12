// Alert rule kinds, shared by the server (alerts.server.ts) and the Alerts page. Pure.
// Only log-based kinds exist since BAC-49 (design 20).

export const AlertMetric = {
  ErrorRate: "error_rate",
  LogRate: "log_rate",
} as const;
export type AlertMetric = (typeof AlertMetric)[keyof typeof AlertMetric];
const ALERT_METRICS: ReadonlySet<string> = new Set(Object.values(AlertMetric));

export function isAlertMetric(value: string): value is AlertMetric {
  return ALERT_METRICS.has(value);
}
