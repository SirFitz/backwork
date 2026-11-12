// The `path` field of inbound HTTP hop records (spec draft 0.10, HOP-24; BAC-52). Pure.
// `op` stays the route template, used for grouping (Performance, Overview, filters, alerts);
// `path` is the path one request actually called, shown for that request.

/** The field name, as written in records. */
export const PATH_FIELD = "path";

/** The text a person sees for one request: the actual path when recorded, else the template. */
export function requestPath(rec: { path: string | null; op: string | null }): string | null {
  return rec.path ?? rec.op;
}

/** The template shown under or beside the path, only when it says something the path does not. */
export function routeHint(rec: { path: string | null; op: string | null }): string | null {
  return rec.path && rec.op && rec.op !== rec.path ? rec.op : null;
}

/**
 * The hover text for a path shown wrapped or cut (Requests list, phone card, request view title):
 * the whole path, and the template on a second line when it differs. Undefined when there is
 * nothing to show.
 */
export function pathTitle(path: string | null, template: string | null): string | undefined {
  const shown = path ?? template;
  if (!shown) return undefined;
  return path && template && template !== path ? `${path}\nroute ${template}` : shown;
}
