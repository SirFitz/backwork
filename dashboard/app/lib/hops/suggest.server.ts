// Query suggestions (BAC-93), server side: whether suggestions are switched on for a scope, the
// observed schema of a project (built from the cached Slow queries board, so it adds no Loki query
// of its own that the board does not already make), and the context the request view's rules use.
// Everything sits behind the stale-while-revalidate cache: a page that has a value never waits.
import { cachedStale } from "~/lib/cache.server";
import { Feature, getControls, resolveEffective, type ControlRow } from "~/lib/controls.server";
import { orgEnvOptions } from "~/lib/env.server";
import { tenantKey, type Tenant } from "~/lib/tenant.server";
import { buildObservedSchema, emptySchema, relationsOf, type ObservedSchema } from "./observed-schema";
import { SlowWindow, type QueryRow } from "./slow-queries";
import { slowQueries, type MetricRunner, type SlowQueries } from "./slow-queries.server";
import { boardSuggestion, type Suggestion, type SuggestContext } from "./suggest";

/** The window the schema and the cross-request figures are read over: the board's longest. */
export const SCHEMA_WINDOW = SlowWindow.H6;
/** A schema younger than this is served as it is (5 minutes). */
export const SCHEMA_FRESH_MS = 5 * 60_000;
/** An older one is still served while a refresh runs, up to this (30 minutes). */
export const SCHEMA_MAX_STALE_MS = 30 * 60_000;
/** Rows of the board sent to the request view: those of its services that touch its tables. */
export const CONTEXT_ROW_LIMIT = 40;

// ---------------------------------------------------------------- the switch

/**
 * Is "Query suggestions" on for a service within a project? Off at the organisation, the project or
 * the service means off (`resolveEffective`). With several projects (a request that crossed
 * environments) it must be on in each.
 */
export function suggestionsOn(rows: readonly ControlRow[], projectIds: ReadonlyArray<string | null>, service: string | null): boolean {
  const scopes = projectIds.length > 0 ? projectIds : [null];
  return scopes.every((p) => resolveEffective(rows, p, service, Feature.Suggestions));
}

/** Project slugs to ids, in the order given; a slug the organisation does not have is dropped. */
export async function projectIdsOf(orgId: string, slugs: readonly string[]): Promise<string[]> {
  const options = await orgEnvOptions(orgId);
  return slugs.map((s) => options.find((o) => o.slug === s)?.id).filter((id): id is string => id !== undefined);
}

/** The switch for each service of a scope, with one read of the organisation's rows. */
export async function switchesFor(orgId: string, projectSlugs: readonly string[], services: readonly string[]): Promise<Record<string, boolean>> {
  const [rows, ids] = await Promise.all([getControls(orgId), projectIdsOf(orgId, projectSlugs)]);
  return Object.fromEntries(services.map((s) => [s, suggestionsOn(rows, ids, s)]));
}

/** Is the organisation-wide switch on (the Schema view and the board column ask this first)? */
export async function orgSuggestionsOn(orgId: string): Promise<boolean> {
  return suggestionsOn(await getControls(orgId), [], null);
}

// ---------------------------------------------------------------- the schema

export interface SchemaResult {
  schema: ObservedSchema;
  window: SlowWindow;
  /** When the board it came from was computed (epoch ms). */
  computedAt: number;
  /** The board was cut at its group cap: the schema is built from the queries that took the most time. */
  groupLimited: boolean;
  /** Query text is switched off, so there are no statements to read. */
  statementsOff: boolean;
}

export function schemaFromBoard(board: SlowQueries): SchemaResult {
  return {
    schema: board.rows.length ? buildObservedSchema(board.rows.map((r) => ({ shape: r.shape, calls: r.calls }))) : emptySchema(),
    window: board.window,
    computedAt: board.computedAt,
    groupLimited: board.groupLimited,
    statementsOff: board.statementsOff,
  };
}

/** The observed schema of a tenant (organisation or one project), cached. */
export function observedSchema(tenant: Tenant, run?: MetricRunner): Promise<SchemaResult> {
  return cachedStale(`schema:${tenantKey(tenant)}`, SCHEMA_FRESH_MS, SCHEMA_MAX_STALE_MS, async () =>
    schemaFromBoard(await slowQueries(tenant, SCHEMA_WINDOW, Date.now(), run)),
  );
}

// ---------------------------------------------------------------- the request view's context

/** What the request view's rules may know: the schema around the request's tables and the board's rows for its services. */
export async function requestContext(tenant: Tenant, services: readonly string[], tables: readonly string[], run?: MetricRunner): Promise<SuggestContext> {
  const board = await slowQueries(tenant, SCHEMA_WINDOW, Date.now(), run);
  const { schema } = await observedSchema(tenant, run);
  const wanted = new Set(tables);
  for (const t of tables) for (const r of relationsOf(schema, t)) { wanted.add(r.from.table); wanted.add(r.to.table); }
  const slim: ObservedSchema = {
    ...schema,
    tables: schema.tables.filter((t) => wanted.has(t.name)),
    relations: schema.relations.filter((r) => wanted.has(r.from.table) && wanted.has(r.to.table)),
  };
  const svc = new Set(services);
  const rows = board.rows.filter((r) => svc.has(r.service) && r.table !== null && wanted.has(r.table)).slice(0, CONTEXT_ROW_LIMIT);
  return { schema: slim, rows };
}

// ---------------------------------------------------------------- the board column

export interface BoardHints {
  /** Hints by row key (`service:shapeId`), only for rows that have one and whose service is switched on. */
  hints: Record<string, Suggestion>;
  /** The whole column is off (organisation or project level). */
  off: boolean;
}

export function rowKeyOf(r: Pick<QueryRow, "service" | "shapeId">): string {
  return `${r.service}:${r.shapeId}`;
}

/** Hints for every row of a board, from the figures and the observed schema. Pure given its inputs. */
export function hintsForBoard(rows: readonly QueryRow[], schema: ObservedSchema, allowed: (service: string) => boolean): Record<string, Suggestion> {
  const out: Record<string, Suggestion> = {};
  for (const r of rows) {
    if (!allowed(r.service)) continue;
    const s = boardSuggestion(r, rows, schema);
    if (s) out[rowKeyOf(r)] = s;
  }
  return out;
}

/** The board column's hints for one window (the page's), switched per organisation, project and service. */
export async function boardHints(tenant: Tenant, window: SlowWindow, run?: MetricRunner): Promise<BoardHints> {
  const [controls, ids] = await Promise.all([getControls(tenant.orgId), tenant.project ? projectIdsOf(tenant.orgId, [tenant.project]) : Promise.resolve([] as string[])]);
  if (!suggestionsOn(controls, ids, null)) return { hints: {}, off: true };
  const [board, { schema }] = await Promise.all([slowQueries(tenant, window, Date.now(), run), observedSchema(tenant, run)]);
  return { hints: hintsForBoard(board.rows, schema, (service) => suggestionsOn(controls, ids, service)), off: false };
}
