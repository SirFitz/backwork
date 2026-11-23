// Which URLs may be tracked. backwork's signed-in screens carry customer data in their URLs (request and
// trace ids, error ids, log searches, environment and project ids, invite and reset tokens), and f.js
// stamps every event with location.href. So the tracker is only ever allowed on an exact allow-list of
// bare screens (never a prefix), and only with no query string or fragment.

const TRACKABLE_PATHS: ReadonlySet<string> = new Set([
  // public
  "/",
  "/pricing",
  "/docs",
  "/about",
  "/security",
  "/privacy",
  "/terms",
  "/changelog",
  "/login",
  "/register",
  "/forgot",
  "/onboarding",
  // the product screens that mark the first core action and the value moment
  "/projects",
  "/requests",
  "/performance",
  "/errors",
  "/insights",
  "/alerts",
  "/billing",
]);

export function normalizePath(pathname: string): string {
  return pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
}

/** True when the URL is one of our own bare screens with no query string or fragment. */
export function isTrackableLocation(loc: Pick<Location, "pathname" | "search" | "hash">): boolean {
  return loc.hash === "" && loc.search === "" && TRACKABLE_PATHS.has(normalizePath(loc.pathname));
}
