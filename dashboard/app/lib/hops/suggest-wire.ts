// What the request view asks the server for and gets back (BAC-93). Pure: the query string both
// sides agree on, and the response type. The server route answers; the browser runs the rules.
import type { SuggestContext } from "./suggest";

/** Search parameters of the `/suggestions` route. */
export const SuggestParam = { Projects: "projects", Services: "services", Tables: "tables" } as const;
export type SuggestParam = (typeof SuggestParam)[keyof typeof SuggestParam];

/** Names a request can hold are label values and table names: short, printable, no separators. */
export const MAX_NAMES = 40;
const NAME = /^[\x21-\x7e]{1,200}$/;

export function cleanNames(raw: string | null): string[] {
  if (!raw) return [];
  return [...new Set(raw.split(",").filter((n) => NAME.test(n)))].sort().slice(0, MAX_NAMES);
}

export interface SuggestWanted {
  projects: string[];
  services: string[];
  tables: string[];
}

export function wantedFrom(url: URL): SuggestWanted {
  return {
    projects: cleanNames(url.searchParams.get(SuggestParam.Projects)),
    services: cleanNames(url.searchParams.get(SuggestParam.Services)),
    tables: cleanNames(url.searchParams.get(SuggestParam.Tables)),
  };
}

export function wantedHref(w: SuggestWanted): string {
  const p = new URLSearchParams();
  if (w.projects.length) p.set(SuggestParam.Projects, w.projects.join(","));
  p.set(SuggestParam.Services, w.services.join(","));
  p.set(SuggestParam.Tables, w.tables.join(","));
  return `/suggestions?${p.toString()}`;
}

export interface SuggestResponse {
  /** Per service: suggestions are switched on for it (organisation, project and service switches). */
  on: Record<string, boolean>;
  /** Null when every service is switched off, so nothing was read. */
  context: SuggestContext | null;
  /** The figures behind the cross-request evidence could not be read: the rules still ran on the request alone. */
  contextError: string | null;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** The untyped edge: what `fetch` parsed from the route, checked before the rules read it. */
export function parseSuggestResponse(v: unknown): SuggestResponse | null {
  if (!isRecord(v) || !isRecord(v.on)) return null;
  const on: Record<string, boolean> = {};
  for (const [k, val] of Object.entries(v.on)) if (typeof val === "boolean") on[k] = val;
  let context: SuggestContext | null = null;
  if (isRecord(v.context)) {
    const c = v.context;
    if (isRecord(c.schema) && Array.isArray(c.schema.tables) && Array.isArray(c.schema.relations) && Array.isArray(c.rows)) context = v.context as unknown as SuggestContext;
  }
  return { on, context, contextError: typeof v.contextError === "string" ? v.contextError : null };
}
