// Analytics config comes from env only. No site key means no script and no server calls, so tests and
// local dev stay clean.
export const DEFAULT_SCRIPT_URL = "https://flatlytics-ingest.silent-voice-a285.workers.dev/f.js";

export interface AnalyticsPublicConfig {
  siteKey: string;
  scriptUrl: string;
  /** Test builds only: lets f.js run on localhost and under browser automation. Never set on a deployed app. */
  testMode: boolean;
}

export interface AnalyticsServerConfig extends AnalyticsPublicConfig {
  secretKey: string | null;
  /** Origin of the ingest worker (script and beacon target). */
  origin: string;
}

const SITE_KEY_PATTERN = /^fl_pub_[0-9a-f]{24}$/;

export function analyticsConfig(env: NodeJS.ProcessEnv = process.env): AnalyticsServerConfig | null {
  const siteKey = (env.FLATLYTICS_SITE_KEY ?? "").trim();
  if (!SITE_KEY_PATTERN.test(siteKey)) return null;
  const scriptUrl = (env.FLATLYTICS_SCRIPT_URL ?? "").trim() || DEFAULT_SCRIPT_URL;
  let origin: string;
  try {
    const u = new URL(scriptUrl);
    if (u.protocol !== "https:") return null;
    origin = u.origin;
  } catch {
    return null;
  }
  const secret = (env.FLATLYTICS_SECRET_KEY ?? "").trim();
  return { siteKey, scriptUrl, origin, secretKey: secret || null, testMode: env.FLATLYTICS_TEST_MODE === "1" };
}

export function publicConfig(cfg: AnalyticsServerConfig | null): AnalyticsPublicConfig | null {
  return cfg ? { siteKey: cfg.siteKey, scriptUrl: cfg.scriptUrl, testMode: cfg.testMode } : null;
}
