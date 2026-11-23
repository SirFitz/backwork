import { analyticsConfig } from "./config.server";

/**
 * The CSP with the analytics origin named in script-src and connect-src, when analytics is configured.
 * It is named on every document (not just the trackable screens) because a visitor can arrive on a
 * screen like /logs and navigate in the app to /billing without a new document. What may actually be
 * tracked is decided in the browser by the exact allow-list in paths.ts.
 */
export function withAnalyticsOrigin(csp: string, env: NodeJS.ProcessEnv = process.env): string {
  const cfg = analyticsConfig(env);
  if (!cfg) return csp;
  return csp
    .replace("script-src 'self' 'unsafe-inline'", `script-src 'self' 'unsafe-inline' ${cfg.origin}`)
    .replace("connect-src 'self'", `connect-src 'self' ${cfg.origin}`);
}
