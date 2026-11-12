/**
 * Data controls (design section 19): the switches that decide what backwork
 * keeps, and the sensitive-data filter applied to log lines before they are
 * saved.
 *
 * Contract (used by Projects/Settings screens, the ingest proxies and the
 * agent's controls endpoint):
 *
 *  - Every feature is ON unless a row switches it off. Off at any level
 *    (organisation, project, service) means off.
 *  - Rows live in `data_controls`. A row with `projectId = null` and
 *    `service = null` is the organisation level; `projectId` set and
 *    `service = null` is the project level; `service` set is the service level
 *    (for one project when `projectId` is set, for every project otherwise).
 *  - Filter patterns: the built-in set below plus each organisation's own
 *    patterns in `filter_patterns`. A built-in can be disabled per organisation
 *    (a row with `builtIn = true` and the built-in's name) but not edited.
 *  - Patterns must work in both JavaScript and Vector's VRL (Rust regex), so
 *    lookaround and back-references are rejected.
 *  - The filter never changes the values of `trace_id`, `hop_id`, `parent_hop`
 *    or `parent_id`.
 */
import { and, eq, sql } from "drizzle-orm";
import { ulid } from "ulid";
import { db, ensureSchema } from "~/db/index.server";
import { dataControls, filterPatterns } from "~/db/schema";
import { logAudit } from "./audit.server";

// ---------------------------------------------------------------------------
// Features
// ---------------------------------------------------------------------------

/** The switchable features, design 19.1. */
export const Feature = {
  /** Ordinary log lines, `kind="log"`. */
  Logs: "logs",
  /** Hop records and link lines, `kind="hop"`. */
  Hops: "hops",
  /** Data-store hop records (`via` db/cache) and the store totals on inbound end records. */
  Stores: "stores",
  /** The `f_` named fields on hop records. */
  NamedFields: "named_fields",
  /** `table` and `stmt` on database hop records (spec 13.2, design 21). */
  Statements: "statements",
  /** `path` on inbound HTTP hop records (spec HOP-24, BAC-52). */
  Paths: "paths",
  /** Link lines (linked IDs). */
  LinkedIds: "linked_ids",
  /** The hop metrics (`backwork_hop_*`). */
  Metrics: "metrics",
  /** The sensitive-data filter of design 19.2. */
  Filter: "filter",
} as const;
export type Feature = (typeof Feature)[keyof typeof Feature];

export const FEATURES: readonly Feature[] = Object.values(Feature);

export function isFeature(v: unknown): v is Feature {
  return typeof v === "string" && (FEATURES as readonly string[]).includes(v);
}

/** Display labels for the switches (business-user wording, design 19.1). */
export const FEATURE_LABEL: Record<Feature, string> = {
  logs: "Ordinary log lines",
  hops: "Hop records",
  stores: "Database and cache calls",
  named_fields: "Named fields",
  statements: "Query text",
  paths: "Request paths",
  linked_ids: "Linked IDs",
  metrics: "Performance figures",
  filter: "Sensitive-data filter",
};

/** What stops when the switch is off (design 19.1), for help text. */
export const FEATURE_EFFECT: Record<Feature, string> = {
  logs: 'Lines labelled kind="log" are no longer saved.',
  hops: 'Hop records are no longer saved; the request view and the Performance page stop for this scope.',
  stores: "Database and cache call records and their totals are no longer saved.",
  named_fields: "The named fields (f_ fields) on hop records are removed before saving.",
  statements: "The table and the statement shape (table, stmt) on database hop records are removed before saving.",
  paths: "The path each request called (path) is removed from hop records before saving; the route template stays.",
  linked_ids: "Link lines are no longer saved.",
  metrics: "Hop metrics are no longer saved.",
  filter: "Sensitive values are no longer replaced with [filtered].",
};

// ---------------------------------------------------------------------------
// Scopes and rows
// ---------------------------------------------------------------------------

export const ScopeLevel = { Org: "org", Project: "project", Service: "service" } as const;
export type ScopeLevel = (typeof ScopeLevel)[keyof typeof ScopeLevel];

/** Where a switch applies. Both null = the organisation. */
export interface ControlScope {
  projectId: string | null;
  service: string | null;
}

export interface ControlRow extends ControlScope {
  orgId: string;
  feature: Feature;
  enabled: boolean;
  updatedBy: string | null;
  updatedAt: Date;
}

export function scopeLevel(scope: ControlScope): ScopeLevel {
  if (scope.service) return ScopeLevel.Service;
  if (scope.projectId) return ScopeLevel.Project;
  return ScopeLevel.Org;
}

/** Service names are label values: 1..200 bytes of 0x21-0x7E (spec HOP-12). */
export function isValidServiceName(s: string): boolean {
  return /^[\x21-\x7e]{1,200}$/.test(s);
}

/**
 * Pure resolution: is `feature` on for (projectId, service), given the org's
 * rows? Off at any applicable level wins; no row means on.
 */
export function resolveEffective(
  rows: readonly ControlRow[],
  projectId: string | null,
  service: string | null,
  feature: Feature,
): boolean {
  for (const r of rows) {
    if (r.feature !== feature || r.enabled) continue;
    if (r.projectId === null && r.service === null) return false; // org level
    if (r.service === null && r.projectId !== null && r.projectId === projectId) return false; // project
    if (r.service !== null && r.service === service && (r.projectId === null || r.projectId === projectId)) return false; // service
  }
  return true;
}

/** Every feature resolved for one scope. */
export function resolveAll(
  rows: readonly ControlRow[],
  projectId: string | null,
  service: string | null,
): Record<Feature, boolean> {
  const out = {} as Record<Feature, boolean>;
  for (const f of FEATURES) out[f] = resolveEffective(rows, projectId, service, f);
  return out;
}

/** Process-local cache so the ingest path does not hit Postgres per push. */
const CACHE_TTL_MS = 10_000;
const rowCache = new Map<string, { at: number; rows: ControlRow[] }>();

function toControlRow(r: typeof dataControls.$inferSelect): ControlRow | null {
  if (!isFeature(r.feature)) return null;
  return {
    orgId: r.orgId,
    projectId: r.projectId,
    service: r.service,
    feature: r.feature,
    enabled: r.enabled,
    updatedBy: r.updatedBy,
    updatedAt: r.updatedAt,
  };
}

/** All switch rows of an organisation (explicit settings only; absent = on). */
export async function getControls(orgId: string, opts: { fresh?: boolean } = {}): Promise<ControlRow[]> {
  const hit = rowCache.get(orgId);
  if (!opts.fresh && hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.rows;
  await ensureSchema();
  const raw = await db.select().from(dataControls).where(eq(dataControls.orgId, orgId));
  const rows = raw.map(toControlRow).filter((r): r is ControlRow => r !== null);
  rowCache.set(orgId, { at: Date.now(), rows });
  return rows;
}

/**
 * Set one switch at one scope and write the audit log. Callers must have
 * checked the user is an owner or admin of the org (design 19.1 "Who").
 */
export async function setControl(
  orgId: string,
  scope: ControlScope,
  feature: Feature,
  enabled: boolean,
  userId: string,
  request?: Request,
): Promise<void> {
  if (!isFeature(feature)) throw new Error(`unknown feature: ${String(feature)}`);
  if (scope.service !== null && !isValidServiceName(scope.service)) throw new Error("invalid service name");
  await ensureSchema();
  const projectId = scope.projectId ?? null;
  const service = scope.service ?? null;
  await db.execute(
    sqlUpsertControl(orgId, projectId, service, feature, enabled, userId),
  );
  rowCache.delete(orgId);
  await logAudit({
    request,
    orgId,
    actorUserId: userId,
    action: "data_control.set",
    target: { feature, enabled, projectId, service, level: scopeLevel({ projectId, service }) },
  });
}

function sqlUpsertControl(
  orgId: string,
  projectId: string | null,
  service: string | null,
  feature: Feature,
  enabled: boolean,
  userId: string,
) {
  return sql`INSERT INTO data_controls (id, org_id, project_id, service, feature, enabled, updated_by, updated_at)
    VALUES (${ulid()}, ${orgId}, ${projectId}, ${service}, ${feature}, ${enabled}, ${userId}, now())
    ON CONFLICT (org_id, (coalesce(project_id, '')), (coalesce(service, '')), feature)
    DO UPDATE SET enabled = EXCLUDED.enabled, updated_by = EXCLUDED.updated_by, updated_at = now()`;
}

/** Is `feature` on for this org / project / service? Defaults to on. */
export async function effective(
  orgId: string,
  projectId: string | null,
  service: string | null,
  feature: Feature,
): Promise<boolean> {
  return resolveEffective(await getControls(orgId), projectId, service, feature);
}

// ---------------------------------------------------------------------------
// Sensitive-data filter (design 19.2)
// ---------------------------------------------------------------------------

export const FILTERED = "[filtered]";

/** Fields whose values the filter never changes. */
export const PROTECTED_FIELDS = ["trace_id", "hop_id", "parent_hop", "parent_id"] as const;

export interface FilterPattern {
  /** Unique per org; built-ins use the names in BUILT_IN_PATTERNS. */
  name: string;
  /** Regex source in the shared JS / Rust-regex subset. */
  pattern: string;
  enabled: boolean;
  builtIn: boolean;
  /**
   * Replacement. Built-ins that keep a key (`password=`) use `$1` for it.
   * Organisation patterns always replace the whole match with [filtered].
   */
  replacement: string;
}

/**
 * Built-in patterns. Order matters: key=value secrets first so a token value
 * is filtered as a whole before narrower patterns look inside it.
 * `(?i)` is written as a leading flag group, accepted by Rust regex; for JS it
 * is translated to the `i` flag by `compilePattern`.
 */
export const BUILT_IN_PATTERNS: readonly FilterPattern[] = [
  {
    name: "passwords",
    pattern: `(?i)((?:password|passwd|pwd|passphrase)"?\\s*[:=]\\s*"?)[^"\\s,&;}]+`,
    replacement: `$1${FILTERED}`,
    enabled: true,
    builtIn: true,
  },
  {
    name: "api_keys_and_tokens",
    pattern: `(?i)((?:api[_-]?key|apikey|x-api-key|access[_-]?token|refresh[_-]?token|auth[_-]?token|secret[_-]?key|client[_-]?secret|secret|token|authorization)"?\\s*[:=]\\s*"?(?:bearer\\s+|basic\\s+)?)[^"\\s,&;}]+`,
    replacement: `$1${FILTERED}`,
    enabled: true,
    builtIn: true,
  },
  {
    name: "known_key_formats",
    pattern: `(?i)bearer\\s+[A-Za-z0-9._~+/=-]{8,}|\\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{8,}\\b|\\bgh[pousr]_[A-Za-z0-9]{20,}\\b|\\bAKIA[0-9A-Z]{16}\\b|\\bxox[abprs]-[A-Za-z0-9-]{10,}\\b|\\beyJ[A-Za-z0-9_-]{5,}\\.[A-Za-z0-9_-]{5,}\\.[A-Za-z0-9_-]{5,}`,
    replacement: FILTERED,
    enabled: true,
    builtIn: true,
  },
  {
    name: "card_numbers",
    // Visa, Mastercard (51-55, 2221-2720), Amex, Discover; 13-19 digits with
    // optional single space or dash separators.
    pattern: `\\b(?:4\\d{3}|5[1-5]\\d{2}|2[2-7]\\d{2}|3[47]\\d{2}|6011|65\\d{2})(?:[ -]?\\d{4}){2}[ -]?\\d{1,7}\\b`,
    replacement: FILTERED,
    enabled: true,
    builtIn: true,
  },
  {
    name: "email_addresses",
    pattern: `[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}`,
    replacement: FILTERED,
    enabled: true,
    builtIn: true,
  },
  {
    name: "phone_numbers",
    // E.164 (+ and 8-15 digits) or a separated national form like
    // (876) 555-1234 / 876-555-1234. Bare digit runs are left alone so IDs,
    // amounts and timestamps are not filtered.
    pattern: `\\+\\d{8,15}\\b|\\+?\\b\\d{1,3}[ .-]\\(?\\d{3}\\)?[ .-]\\d{3}[ .-]\\d{4}\\b|\\(\\d{3}\\)\\s?\\d{3}[ .-]\\d{4}\\b|\\b\\d{3}[.-]\\d{3}[.-]\\d{4}\\b`,
    replacement: FILTERED,
    enabled: true,
    builtIn: true,
  },
];

const MAX_PATTERN_LENGTH = 500;
const MAX_ORG_PATTERNS = 50;

/** Reasons a custom pattern is refused. */
export const PatternError = {
  Empty: "empty",
  TooLong: "too_long",
  Unsupported: "unsupported_syntax",
  Invalid: "invalid_regex",
  MatchesEmpty: "matches_empty",
  BadName: "bad_name",
} as const;
export type PatternError = (typeof PatternError)[keyof typeof PatternError];

/** Validate an organisation pattern. Returns null when it is acceptable. */
export function validatePattern(name: string, pattern: string): PatternError | null {
  if (!/^[a-z0-9_ -]{1,60}$/i.test(name)) return PatternError.BadName;
  if (!pattern) return PatternError.Empty;
  if (pattern.length > MAX_PATTERN_LENGTH) return PatternError.TooLong;
  // Lookaround and back-references do not exist in Rust regex (Vector).
  if (/\(\?<?[=!]|\\[1-9]|\\k</.test(pattern)) return PatternError.Unsupported;
  let re: RegExp;
  try {
    re = compilePattern(pattern);
  } catch {
    return PatternError.Invalid;
  }
  if (re.test("")) return PatternError.MatchesEmpty;
  return null;
}

/** Compile a shared-subset pattern for JS: a leading `(?i)` becomes the i flag. */
export function compilePattern(pattern: string): RegExp {
  let src = pattern;
  let flags = "g";
  if (src.startsWith("(?i)")) {
    src = src.slice(4);
    flags += "i";
  }
  return new RegExp(src, flags);
}

export interface CompiledFilter {
  rules: { name: string; re: RegExp; replacement: string }[];
}

/** Compile the enabled patterns, in order (built-ins first). */
export function compileFilter(patterns: readonly FilterPattern[]): CompiledFilter {
  const rules: CompiledFilter["rules"] = [];
  for (const p of patterns) {
    if (!p.enabled) continue;
    try {
      rules.push({ name: p.name, re: compilePattern(p.pattern), replacement: p.builtIn ? p.replacement : FILTERED });
    } catch {
      /* invalid patterns are refused on save; skip any that slipped through */
    }
  }
  return { rules };
}

const ID_VALUE_RE = /\b(?:trace_id|hop_id|parent_hop|parent_id)"?\s*[:=]\s*"?([0-9a-f]{16,32}|[0-9a-f]{2}-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2})/g;

/**
 * Apply the filter to one raw log line. The values of the protected ID fields
 * are masked first and restored afterwards, so no pattern can alter them.
 */
export function applyFilter(line: string, filter: CompiledFilter): string {
  if (filter.rules.length === 0 || line.length === 0) return line;
  const saved: string[] = [];
  let out = line.replace(ID_VALUE_RE, (m: string, v: string) => {
    saved.push(v);
    return m.slice(0, m.length - v.length) + `\u0000${saved.length - 1}\u0000`;
  });
  for (const r of filter.rules) {
    r.re.lastIndex = 0;
    out = out.replace(r.re, r.replacement);
  }
  return out.replace(/\u0000(\d+)\u0000/g, (_m: string, i: string) => saved[Number(i)] ?? "");
}

/** Built-ins (with this org's enabled overrides) followed by the org's own patterns. */
export async function getFilterPatterns(orgId: string): Promise<FilterPattern[]> {
  await ensureSchema();
  const rows = await db.select().from(filterPatterns).where(eq(filterPatterns.orgId, orgId));
  const builtInOverride = new Map<string, boolean>();
  const own: FilterPattern[] = [];
  for (const r of rows) {
    if (r.builtIn) builtInOverride.set(r.name, r.enabled);
    else own.push({ name: r.name, pattern: r.pattern, enabled: r.enabled, builtIn: false, replacement: FILTERED });
  }
  const builtIns = BUILT_IN_PATTERNS.map((p) => ({ ...p, enabled: builtInOverride.get(p.name) ?? p.enabled }));
  own.sort((a, b) => a.name.localeCompare(b.name));
  return [...builtIns, ...own];
}

export interface UpsertPatternInput {
  name: string;
  /** Ignored for built-ins. */
  pattern?: string;
  enabled: boolean;
}

/**
 * Create or update an organisation pattern, or switch a built-in on/off.
 * Throws `Error(PatternError)` on an invalid pattern. Writes the audit log.
 */
export async function upsertFilterPattern(
  orgId: string,
  input: UpsertPatternInput,
  userId: string,
  request?: Request,
): Promise<void> {
  await ensureSchema();
  const builtIn = BUILT_IN_PATTERNS.find((p) => p.name === input.name);
  let pattern = builtIn?.pattern ?? input.pattern ?? "";
  if (!builtIn) {
    const err = validatePattern(input.name, pattern);
    if (err) throw new Error(err);
    const existing = await db.select({ name: filterPatterns.name }).from(filterPatterns)
      .where(and(eq(filterPatterns.orgId, orgId), eq(filterPatterns.builtIn, false)));
    if (existing.length >= MAX_ORG_PATTERNS && !existing.some((e) => e.name === input.name)) {
      throw new Error("too_many_patterns");
    }
  } else {
    pattern = "";
  }
  await db.execute(sql`INSERT INTO filter_patterns (id, org_id, name, pattern, enabled, built_in, updated_by, updated_at)
    VALUES (${ulid()}, ${orgId}, ${input.name}, ${pattern}, ${input.enabled}, ${builtIn !== undefined}, ${userId}, now())
    ON CONFLICT (org_id, name) DO UPDATE SET pattern = EXCLUDED.pattern, enabled = EXCLUDED.enabled,
      updated_by = EXCLUDED.updated_by, updated_at = now()`);
  filterCache.delete(orgId);
  await logAudit({
    request,
    orgId,
    actorUserId: userId,
    action: "filter_pattern.set",
    target: { name: input.name, enabled: input.enabled, builtIn: builtIn !== undefined },
  });
}

/** Remove an organisation pattern (built-ins cannot be removed, only disabled). */
export async function deleteFilterPattern(orgId: string, name: string, userId: string, request?: Request): Promise<void> {
  await ensureSchema();
  await db.delete(filterPatterns).where(and(eq(filterPatterns.orgId, orgId), eq(filterPatterns.name, name), eq(filterPatterns.builtIn, false)));
  filterCache.delete(orgId);
  await logAudit({ request, orgId, actorUserId: userId, action: "filter_pattern.delete", target: { name } });
}

const filterCache = new Map<string, { at: number; filter: CompiledFilter }>();

/** Compiled filter for an org, cached for 10 s (ingest path). */
export async function getCompiledFilter(orgId: string): Promise<CompiledFilter> {
  const hit = filterCache.get(orgId);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.filter;
  const filter = compileFilter(await getFilterPatterns(orgId));
  filterCache.set(orgId, { at: Date.now(), filter });
  return filter;
}

// ---------------------------------------------------------------------------
// Agent snapshot (GET /ingest/controls, project token)
// ---------------------------------------------------------------------------

export interface ControlsSnapshot {
  /** Changes whenever any switch or pattern changes; the agent reloads on change. */
  version: string;
  /** Effective switches for the project as a whole. */
  project: Record<Feature, boolean>;
  /** Services with at least one switch differing from the project. */
  services: Record<string, Record<Feature, boolean>>;
  /** Enabled filter patterns, in order. Empty when the filter is off for the project. */
  patterns: { name: string; pattern: string; replacement: string }[];
  /** Container or process name (`source`) -> the service its hop records name, where they
   *  differ: ordinary lines of that source are stored under the service's own name (BAC-51). */
  serviceNames: Record<string, string>;
}

/** Switch rows with any service written under a source name moved to that service's own name,
 *  so a switch acts on the lines it names whichever label they were stored under. Off wins. */
export function canonicalRows(rows: readonly ControlRow[], bySource: ReadonlyMap<string, string>): ControlRow[] {
  return rows.map((r) => (r.service !== null && bySource.has(r.service) ? { ...r, service: bySource.get(r.service) as string } : r));
}

/** What an agent for one project must enforce. */
export async function controlsSnapshot(
  orgId: string,
  projectId: string,
  serviceNames: Readonly<Record<string, string>> = {},
): Promise<ControlsSnapshot> {
  const rows = canonicalRows(await getControls(orgId), new Map(Object.entries(serviceNames)));
  const project = resolveAll(rows, projectId, null);
  const services: Record<string, Record<Feature, boolean>> = {};
  for (const r of rows) {
    if (r.service === null || (r.projectId !== null && r.projectId !== projectId)) continue;
    services[r.service] = resolveAll(rows, projectId, r.service);
  }
  const patterns = project.filter
    ? (await getFilterPatterns(orgId)).filter((p) => p.enabled).map((p) => ({
        name: p.name,
        pattern: p.pattern,
        replacement: p.builtIn ? p.replacement : FILTERED,
      }))
    : [];
  const names = Object.fromEntries(Object.entries(serviceNames).sort(([a], [b]) => a.localeCompare(b)));
  const body = JSON.stringify({ project, services, patterns, serviceNames: names });
  const { createHash } = await import("node:crypto");
  const version = createHash("sha256").update(body).digest("hex").slice(0, 16);
  return { version, project, services, patterns, serviceNames: names };
}
