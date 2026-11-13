// The Projects and Settings screens' side of the data controls (design 19, frame 7): builds what
// the switches show, and applies a change posted from them. All storage, resolution and audit
// logging is in `controls.server.ts` (owned by the collector work); this module only reads it
// and calls `setControl` / `upsertFilterPattern` / `deleteFilterPattern`.

import { json } from "@remix-run/node";
import {
  BUILT_IN_PATTERNS,
  FEATURE_LABEL,
  Feature,
  applyFilter,
  compileFilter,
  deleteFilterPattern,
  getControls,
  getFilterPatterns,
  isFeature,
  isValidServiceName,
  resolveEffective,
  setControl,
  upsertFilterPattern,
  type ControlRow,
  type FilterPattern,
  canonicalRows,
} from "~/lib/controls.server";
import { config, fetchJson } from "~/lib/config.server";
import { hasRole, type OrgContext } from "~/lib/auth/context.server";
import { tenantOf, type Tenant } from "~/lib/tenant.server";
import { canonicalName } from "~/lib/service-names";
import { serviceNamesWithin } from "~/lib/service-names.server";
import * as vm from "~/lib/vm.server";

/** The switches shown in the "Collected" list and the by-service grid, in frame order. */
export const COLLECTED: readonly Feature[] = [
  Feature.Logs,
  Feature.Hops,
  Feature.Stores,
  Feature.NamedFields,
  Feature.Statements,
  Feature.Paths,
  Feature.LinkedIds,
  Feature.Metrics,
];

/** One line of plain meaning under each switch (frame 7). */
export const FEATURE_MEANING: Record<Feature, string> = {
  [Feature.Logs]: "What each service prints.",
  [Feature.Hops]: "The path and timing of every request.",
  [Feature.Stores]: "Time spent in each data store.",
  [Feature.NamedFields]: "Extra details your team adds to a request.",
  [Feature.Statements]: "The table and the shape of each database query, values removed.",
  [Feature.Paths]: "The path each request called, long parts masked.",
  [Feature.LinkedIds]: "Order numbers and provider references.",
  [Feature.Metrics]: "Rate, errors and latency.",
  [Feature.Filter]: "Replaces sensitive values with [filtered].",
};

/** Column heads of the by-service grid (frame 7). */
export const GRID_HEAD: Record<Feature, string> = {
  [Feature.Logs]: "Log lines",
  [Feature.Hops]: "Hop records",
  [Feature.Stores]: "Database and cache",
  [Feature.NamedFields]: "Named fields",
  [Feature.Statements]: "Query text",
  [Feature.Paths]: "Request paths",
  [Feature.LinkedIds]: "Linked IDs",
  [Feature.Metrics]: "Figures",
  [Feature.Filter]: "Filter",
};

/** Business wording for the built-in patterns, in the frame's order. */
const BUILT_IN_LABEL: Record<string, string> = {
  card_numbers: "Card numbers",
  email_addresses: "Email addresses",
  phone_numbers: "Phone numbers",
  passwords: "Passwords",
  api_keys_and_tokens: "API keys and tokens",
  known_key_formats: "Known key formats",
};
const BUILT_IN_ORDER = Object.keys(BUILT_IN_LABEL);

/** The before/after line of frame 7. */
export const EXAMPLE_LINE = "callback for member 111122223333 at 404-555-0100, pat@example.com";

export const ControlIntent = {
  Switch: "control",
  PatternToggle: "pattern-toggle",
  PatternAdd: "pattern-add",
  PatternDelete: "pattern-delete",
} as const;
export type ControlIntent = (typeof ControlIntent)[keyof typeof ControlIntent];
const INTENTS: readonly string[] = Object.values(ControlIntent);

export interface SwitchView {
  feature: Feature;
  label: string;
  meaning: string;
  /** What this scope's own switch says. */
  on: boolean;
  /** Off at a wider scope (organisation), so this switch cannot turn it on. */
  lockedOff: boolean;
}

export interface CellView {
  feature: Feature;
  on: boolean;
  /** Off for the whole project or organisation: shown off and disabled. */
  disabled: boolean;
}

export interface ServiceGridRow {
  service: string;
  cells: CellView[];
}

export interface PatternView {
  name: string;
  label: string;
  enabled: boolean;
  builtIn: boolean;
}

export interface ControlsView {
  /** null = the organisation (Settings). */
  projectId: string | null;
  switches: SwitchView[];
  filter: SwitchView;
  services: ServiceGridRow[];
  patterns: PatternView[];
  example: { before: string; saved: string };
  lastChange: string | null;
  canManage: boolean;
}

function isOrgRow(r: ControlRow): boolean {
  return r.projectId === null && r.service === null;
}

function ownValue(rows: readonly ControlRow[], projectId: string | null, feature: Feature): boolean {
  const row = rows.find((r) => r.feature === feature && r.service === null && r.projectId === projectId);
  return row ? row.enabled : true;
}

function switchView(rows: readonly ControlRow[], projectId: string | null, feature: Feature): SwitchView {
  const orgOff = projectId !== null && rows.some((r) => isOrgRow(r) && r.feature === feature && !r.enabled);
  return {
    feature,
    label: FEATURE_LABEL[feature],
    meaning: FEATURE_MEANING[feature],
    on: orgOff ? false : ownValue(rows, projectId, feature),
    lockedOff: orgOff,
  };
}

function patternLabel(p: FilterPattern): string {
  return p.builtIn ? BUILT_IN_LABEL[p.name] ?? p.name.replace(/_/g, " ") : p.name;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function fmtWhen(d: Date): string {
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${hh}:${mm} UTC`;
}

/** "ordinary log lines switched off for document-service, 11 Nov 14:02 UTC" */
export function describeLastChange(rows: readonly ControlRow[], projectId: string | null): string | null {
  const mine = rows.filter((r) => r.projectId === projectId && (projectId !== null || r.service === null));
  if (!mine.length) return null;
  const last = mine.reduce((a, b) => (b.updatedAt > a.updatedAt ? b : a));
  const what = FEATURE_LABEL[last.feature].toLowerCase();
  const where = last.service ? ` for ${last.service}` : projectId ? " for this project" : " for the organisation";
  return `${what} switched ${last.enabled ? "on" : "off"}${where}, ${fmtWhen(new Date(last.updatedAt))}.`;
}

/** Pure: the whole panel from the org's rows, patterns and service names. */
export function buildControlsView(input: {
  rows: readonly ControlRow[];
  patterns: readonly FilterPattern[];
  projectId: string | null;
  services: readonly string[];
  canManage: boolean;
}): ControlsView {
  const { rows, projectId } = input;
  const switches = COLLECTED.map((f) => switchView(rows, projectId, f));
  const filter = switchView(rows, projectId, Feature.Filter);
  const scopeOff = new Set(COLLECTED.filter((f) => !resolveEffective(rows, projectId, null, f)));
  const services: ServiceGridRow[] = input.services.map((service) => ({
    service,
    cells: COLLECTED.map((feature) => ({
      feature,
      on: resolveEffective(rows, projectId, service, feature),
      disabled: scopeOff.has(feature),
    })),
  }));
  const ordered = [...input.patterns].sort((a, b) => {
    if (a.builtIn !== b.builtIn) return a.builtIn ? -1 : 1;
    if (a.builtIn) return BUILT_IN_ORDER.indexOf(a.name) - BUILT_IN_ORDER.indexOf(b.name);
    return a.name.localeCompare(b.name);
  });
  const filterOn = resolveEffective(rows, projectId, null, Feature.Filter);
  const saved = filterOn ? applyFilter(EXAMPLE_LINE, compileFilter(input.patterns)) : EXAMPLE_LINE;
  return {
    projectId,
    switches,
    filter,
    services,
    patterns: ordered.map((p) => ({ name: p.name, label: patternLabel(p), enabled: p.enabled, builtIn: p.builtIn })),
    example: { before: EXAMPLE_LINE, saved },
    lastChange: describeLastChange(rows, projectId),
    canManage: input.canManage,
  };
}

export function canManageControls(ctx: OrgContext): boolean {
  return hasRole(ctx.role, "admin");
}

// ---------------------------------------------------------------- services of a project

type LabelValues = { status: string; data?: string[] };

/** Services seen for a project: log lines in Loki over 7 days, hop metrics in VictoriaMetrics,
 *  and any service that already has a switch. Every query carries the org scope. */
export async function projectServices(
  tenant: Tenant,
  projectSlug: string,
  rows: readonly ControlRow[],
  projectId: string,
  serviceOf: ReadonlyMap<string, string> = new Map(),
): Promise<string[]> {
  const names = new Set<string>();
  for (const r of rows) if (r.service && (r.projectId === projectId || r.projectId === null)) names.add(r.service);
  const matchers = [`project=${JSON.stringify(projectSlug)}`];
  if (!tenant.platform) matchers.unshift(`org_id=${JSON.stringify(tenant.orgId)}`);
  const end = Date.now();
  const params = new URLSearchParams({
    query: `{${matchers.join(",")}}`,
    start: String((end - 7 * 86400_000) * 1e6),
    end: String(end * 1e6),
  });
  const [logs, hops] = await Promise.all([
    fetchJson<LabelValues>(`${config.lokiUrl}/loki/api/v1/label/service/values?${params.toString()}`, { timeoutMs: 5000, retries: 0 })
      .then((r) => r.data ?? [])
      .catch(() => [] as string[]),
    vm.instant(`count by (service) (last_over_time(backwork_hop_started_total{project=${JSON.stringify(projectSlug)}}[14d]))`, undefined, tenant)
      .then((r) => r.map((s) => s.metric.service ?? ""))
      .catch(() => [] as string[]),
  ]);
  for (const s of [...logs, ...hops]) if (s && isValidServiceName(s)) names.add(s);
  // One row per service (BAC-51): a container name whose hop records name a service is that service.
  return [...new Set([...names].map((n) => canonicalName(n, serviceOf)))].sort();
}

/** The view for one scope, loaded from the store. */
export async function loadControlsView(opts: {
  orgId: string;
  projectId: string | null;
  services: (rows: readonly ControlRow[]) => Promise<string[]>;
  canManage: boolean;
  /** source -> service: switch rows written under a container name show on its service's row. */
  serviceOf?: ReadonlyMap<string, string>;
}): Promise<ControlsView> {
  const [stored, patterns] = await Promise.all([getControls(opts.orgId, { fresh: true }), getFilterPatterns(opts.orgId)]);
  const rows = opts.serviceOf ? canonicalRows(stored, opts.serviceOf) : stored;
  const services = await opts.services(rows);
  return buildControlsView({ rows, patterns, projectId: opts.projectId, services, canManage: opts.canManage });
}

// ---------------------------------------------------------------- applying a change

export function isControlIntent(v: string): v is ControlIntent {
  return INTENTS.includes(v);
}

export interface ControlResult {
  ok: boolean;
  error?: string;
}

const PATTERN_ERROR_TEXT: Record<string, string> = {
  bad_name: "A name is 1 to 60 letters, digits, spaces, dashes or underscores.",
  empty: "Enter a pattern.",
  too_long: "A pattern is at most 500 characters.",
  unsupported_syntax: "Lookaround and back-references are not supported.",
  invalid_regex: "That is not a valid regular expression.",
  matches_empty: "That pattern matches empty text, so it would filter everything.",
  too_many_patterns: "An organisation can have at most 50 patterns.",
};

/**
 * Apply one posted change. Owners and admins only (design 19.1 "Who"); anyone else gets 403
 * and nothing is written. `allowedProjectIds` limits a change to the organisation's projects.
 */
export async function applyControlChange(
  request: Request,
  ctx: OrgContext,
  fd: FormData,
  allowedProjectIds: ReadonlySet<string>
) {
  if (!canManageControls(ctx)) {
    return json<ControlResult>({ ok: false, error: "Only owners and admins can change data controls." }, { status: 403 });
  }
  const intent = String(fd.get("intent") ?? "");
  const userId = ctx.user.id;
  const orgId = ctx.org.id;
  try {
    if (intent === ControlIntent.Switch) {
      const feature = String(fd.get("feature") ?? "");
      const projectRaw = String(fd.get("projectId") ?? "");
      const serviceRaw = String(fd.get("service") ?? "");
      const enabled = String(fd.get("enabled") ?? "") === "1";
      if (!isFeature(feature)) return json<ControlResult>({ ok: false, error: "Unknown switch." }, { status: 400 });
      const projectId = projectRaw || null;
      if (projectId && !allowedProjectIds.has(projectId)) return json<ControlResult>({ ok: false, error: "Project not found." }, { status: 404 });
      const service = serviceRaw || null;
      if (service && (!projectId || !isValidServiceName(service))) return json<ControlResult>({ ok: false, error: "Invalid service." }, { status: 400 });
      if (service && feature === Feature.Filter) return json<ControlResult>({ ok: false, error: "The filter is set per project." }, { status: 400 });
      await setControl(orgId, { projectId, service }, feature, enabled, userId, request);
      // Rows written earlier under one of this service's container names act on the same lines:
      // give them the same value, so the merged row's switch is what holds (BAC-51).
      if (service) {
        const names = await serviceNamesWithin(tenantOf(orgId), 3000);
        const sources = new Set(names.sourcesOf.get(service) ?? []);
        sources.delete(service);
        const stale = (await getControls(orgId, { fresh: true })).filter(
          (r) => r.feature === feature && r.service !== null && sources.has(r.service) && r.projectId === projectId && r.enabled !== enabled,
        );
        for (const r of stale) await setControl(orgId, { projectId, service: r.service }, feature, enabled, userId, request);
      }
      return json<ControlResult>({ ok: true });
    }
    if (intent === ControlIntent.PatternToggle) {
      const name = String(fd.get("name") ?? "");
      const enabled = String(fd.get("enabled") ?? "") === "1";
      const known = (await getFilterPatterns(orgId)).find((p) => p.name === name);
      if (!known) return json<ControlResult>({ ok: false, error: "Pattern not found." }, { status: 404 });
      await upsertFilterPattern(orgId, { name, pattern: known.pattern, enabled }, userId, request);
      return json<ControlResult>({ ok: true });
    }
    if (intent === ControlIntent.PatternAdd) {
      const name = String(fd.get("name") ?? "").trim();
      const pattern = String(fd.get("pattern") ?? "");
      if (BUILT_IN_PATTERNS.some((p) => p.name === name)) return json<ControlResult>({ ok: false, error: "That name belongs to a built-in pattern." }, { status: 400 });
      await upsertFilterPattern(orgId, { name, pattern, enabled: true }, userId, request);
      return json<ControlResult>({ ok: true });
    }
    if (intent === ControlIntent.PatternDelete) {
      await deleteFilterPattern(orgId, String(fd.get("name") ?? ""), userId, request);
      return json<ControlResult>({ ok: true });
    }
  } catch (e) {
    const code = e instanceof Error ? e.message : String(e);
    return json<ControlResult>({ ok: false, error: PATTERN_ERROR_TEXT[code] ?? "The change was not saved." }, { status: 400 });
  }
  return json<ControlResult>({ ok: false, error: "Unknown action." }, { status: 400 });
}

