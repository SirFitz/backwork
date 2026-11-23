import { useEffect, useRef } from "react";
import { useLocation } from "@remix-run/react";
import { installStub, pageview } from "~/lib/analytics/client";
import type { AnalyticsPublicConfig } from "~/lib/analytics/config.server";
import { isTrackableLocation, normalizePath } from "~/lib/analytics/paths";

const SCRIPT_ID = "flatlytics";

/**
 * Loads the Flatlytics tracker, but only while the visitor is on one of backwork's bare allow-listed
 * screens. Signed-in screens with ids, searches or tokens in their URLs never get it. It is added after
 * hydration rather than rendered, so the server HTML is the same with or without it.
 */
export function Analytics({ siteKey, scriptUrl, testMode }: AnalyticsPublicConfig) {
  const { pathname, search, hash } = useLocation();
  const lastPath = useRef<string | null>(null);

  useEffect(() => {
    installStub();
    if (!isTrackableLocation({ pathname, search, hash })) {
      lastPath.current = null; // coming back to a tracked screen counts as a new view
      return;
    }
    const path = normalizePath(pathname);
    if (!document.getElementById(SCRIPT_ID)) {
      const el = document.createElement("script");
      el.id = SCRIPT_ID;
      el.src = scriptUrl;
      el.async = true;
      el.setAttribute("data-site", siteKey);
      // f.js stamps events with location.href, which after a client-side navigation to a screen with an
      // id or a search in its URL would carry it. Automatic SPA pageviews, vitals and declarative click
      // events are off; pageviews and events are sent from here and from track(), allow-listed screens only.
      el.setAttribute("data-spa", "false");
      el.setAttribute("data-vitals", "false");
      el.setAttribute("data-events", "false");
      if (testMode) {
        el.setAttribute("data-allow-localhost", "");
        el.setAttribute("data-allow-automation", "");
      }
      document.head.appendChild(el);
      lastPath.current = path; // f.js sends the first pageview itself
    } else if (lastPath.current !== path) {
      lastPath.current = path;
      pageview();
    }
  }, [pathname, search, hash, siteKey, scriptUrl, testMode]);

  return null;
}
