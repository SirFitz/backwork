// The Requests list's text box ("Filter by path, route, domain or service"). Pure: client code.

/** The parts of a list row the box matches. */
export interface RequestTextFacts {
  route: string;
  path: string | null;
  service: string;
  /** HOP-27; missing on older records. */
  host?: string | null;
}

/** True when the trimmed, case-insensitive text is part of the row's route, path, domain or service.
 *  Empty text matches every row. */
export function matchesRequestText(row: RequestTextFacts, text: string): boolean {
  const t = text.trim().toLowerCase();
  if (!t) return true;
  return [row.route, row.path, row.host, row.service].some((v) => typeof v === "string" && v.toLowerCase().includes(t));
}
