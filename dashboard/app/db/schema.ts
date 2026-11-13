import { pgTable, text, boolean, integer, bigint, timestamp, jsonb, uniqueIndex, index, primaryKey } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export type Role = "owner" | "admin" | "member" | "viewer";
export const ROLE_RANK: Record<Role, number> = { viewer: 0, member: 1, admin: 2, owner: 3 };

const id = (name = "id") => text(name).primaryKey();
const ts = () => ({
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const users = pgTable("users", {
  id: id(),
  email: text("email").notNull(),
  name: text("name").notNull().default(""),
  passwordHash: text("password_hash").notNull(),
  isPlatformAdmin: boolean("is_platform_admin").notNull().default(false),
  tokenVersion: integer("token_version").notNull().default(0),
  emailVerifiedAt: timestamp("email_verified_at", { withTimezone: true }),
  lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
  ...ts(),
}, (t) => ({ emailUniq: uniqueIndex("users_email_uniq").on(sql`lower(${t.email})`) }));

export const orgs = pgTable("orgs", {
  id: id(),
  name: text("name").notNull(),
  slug: text("slug").notNull(),
  status: text("status").$type<"active" | "suspended">().notNull().default("active"),
  /** A plan id (free, team, business, enterprise) or "unmetered". See lib/plans/limits.ts. */
  plan: text("plan").notNull().default("unmetered"),
  requestsLimit: integer("requests_limit"),
  storageLimitBytes: bigint("storage_limit_bytes", { mode: "number" }),
  ...ts(),
}, (t) => ({ slugUniq: uniqueIndex("orgs_slug_uniq").on(t.slug) }));

/** What an organisation has collected in one billing month (UTC, YYYY-MM). */
export const orgUsage = pgTable("org_usage", {
  orgId: text("org_id").notNull().references(() => orgs.id, { onDelete: "cascade" }),
  period: text("period").notNull(),
  requests: bigint("requests", { mode: "number" }).notNull().default(0),
  bytes: bigint("bytes", { mode: "number" }).notNull().default(0),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({ pk: primaryKey({ columns: [t.orgId, t.period] }) }));

export const memberships = pgTable("memberships", {
  id: id(),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  orgId: text("org_id").notNull().references(() => orgs.id, { onDelete: "cascade" }),
  role: text("role").$type<Role>().notNull().default("member"),
  ...ts(),
}, (t) => ({
  userOrgUniq: uniqueIndex("memberships_user_org_uniq").on(t.userId, t.orgId),
  orgIdx: index("memberships_org_idx").on(t.orgId),
}));

export const teams = pgTable("teams", {
  id: id(),
  orgId: text("org_id").notNull().references(() => orgs.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  slug: text("slug").notNull(),
  ...ts(),
}, (t) => ({ orgSlugUniq: uniqueIndex("teams_org_slug_uniq").on(t.orgId, t.slug) }));

export const teamMembers = pgTable("team_members", {
  id: id(),
  teamId: text("team_id").notNull().references(() => teams.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  ...ts(),
}, (t) => ({ teamUserUniq: uniqueIndex("team_members_team_user_uniq").on(t.teamId, t.userId) }));

// a monitored project/environment within an org (gets its own ingest token in Phase 2)
export const projects = pgTable("projects", {
  id: id(),
  orgId: text("org_id").notNull().references(() => orgs.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  slug: text("slug").notNull(),
  ingestTokenHash: text("ingest_token_hash"),
  ...ts(),
}, (t) => ({
  orgSlugUniq: uniqueIndex("projects_org_slug_uniq").on(t.orgId, t.slug),
  ingestTokenHashIdx: index("projects_ingest_token_hash_idx").on(t.ingestTokenHash),
}));

export const invitations = pgTable("invitations", {
  id: id(),
  orgId: text("org_id").notNull().references(() => orgs.id, { onDelete: "cascade" }),
  email: text("email").notNull(),
  role: text("role").$type<Role>().notNull().default("member"),
  token: text("token").notNull(),
  invitedByUserId: text("invited_by_user_id").references(() => users.id, { onDelete: "set null" }),
  acceptedAt: timestamp("accepted_at", { withTimezone: true }),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  tokenUniq: uniqueIndex("invitations_token_uniq").on(t.token),
  orgEmailIdx: index("invitations_org_email_idx").on(t.orgId, t.email),
}));

export const alertRules = pgTable("alert_rules", {
  id: id(),
  orgId: text("org_id").notNull().references(() => orgs.id, { onDelete: "cascade" }),
  data: jsonb("data").$type<Record<string, unknown>>().notNull(),
  ...ts(),
}, (t) => ({ orgIdx: index("alert_rules_org_idx").on(t.orgId) }));

export const alertChannels = pgTable("alert_channels", {
  id: id(),
  orgId: text("org_id").notNull().references(() => orgs.id, { onDelete: "cascade" }),
  data: jsonb("data").$type<Record<string, unknown>>().notNull(),
  ...ts(),
}, (t) => ({ orgIdx: index("alert_channels_org_idx").on(t.orgId) }));

// Which service answered calls to a peer host or queue (design 9, phase 4). Saved whenever an
// outbound hop is linked to its inbound hop; read to tell a known service that did not report
// ("No record from") from a host that never has ("not instrumented yet").
export const peerServices = pgTable("peer_services", {
  orgId: text("org_id").notNull(),
  peer: text("peer").notNull(),
  service: text("service").notNull(),
  lastSeen: timestamp("last_seen", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({ pk: primaryKey({ columns: [t.orgId, t.peer, t.service] }) }));

export const migrations = pgTable("migrations", {
  name: text("name").primaryKey(),
  at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
});

export const passwordResets = pgTable("password_resets", {
  id: id(),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  usedAt: timestamp("used_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({ tokenUniq: uniqueIndex("password_resets_token_uniq").on(t.tokenHash) }));

export const auditLog = pgTable("audit_log", {
  id: id(),
  orgId: text("org_id").references(() => orgs.id, { onDelete: "cascade" }),
  actorUserId: text("actor_user_id").references(() => users.id, { onDelete: "set null" }),
  action: text("action").notNull(),
  target: jsonb("target").$type<Record<string, unknown>>().default({}),
  ip: text("ip"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({ orgIdx: index("audit_log_org_idx").on(t.orgId) }));

// Error tracking (CMP-1): one error_group per unique fingerprint per org;
// error_events are the individual occurrences (bounded by retention).
export const errorGroups = pgTable("error_groups", {
  id: id(),
  orgId: text("org_id").notNull().references(() => orgs.id, { onDelete: "cascade" }),
  project: text("project").notNull().default(""),
  fingerprint: text("fingerprint").notNull(),
  type: text("type").notNull().default("Error"),
  message: text("message").notNull().default(""),
  service: text("service").notNull().default(""),
  level: text("level").notNull().default("error"),
  status: text("status").$type<"open" | "resolved" | "ignored">().notNull().default("open"),
  count: integer("count").notNull().default(0),
  sample: jsonb("sample").$type<Record<string, unknown>>().default({}),
  firstSeen: timestamp("first_seen", { withTimezone: true }).notNull().defaultNow(),
  lastSeen: timestamp("last_seen", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  orgFp: uniqueIndex("error_groups_org_fp_uniq").on(t.orgId, t.fingerprint),
  orgLast: index("error_groups_org_last_idx").on(t.orgId, t.lastSeen),
}));

export const errorEvents = pgTable("error_events", {
  id: id(),
  groupId: text("group_id").notNull().references(() => errorGroups.id, { onDelete: "cascade" }),
  orgId: text("org_id").notNull(),
  payload: jsonb("payload").$type<Record<string, unknown>>().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({ groupIdx: index("error_events_group_idx").on(t.groupId, t.createdAt) }));

// Public read-API keys (DX-1): org-scoped, hashed at rest (bwk_… shown once).
export const apiKeys = pgTable("api_keys", {
  id: id(),
  orgId: text("org_id").notNull().references(() => orgs.id, { onDelete: "cascade" }),
  name: text("name").notNull().default(""),
  keyHash: text("key_hash").notNull(),
  createdByUserId: text("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({ orgIdx: index("api_keys_org_idx").on(t.orgId), hashUniq: uniqueIndex("api_keys_hash_uniq").on(t.keyHash) }));

// Data controls (design 19.1): explicit switch settings. No row = on.
// project_id null + service null = organisation level.
export const dataControls = pgTable("data_controls", {
  id: id(),
  orgId: text("org_id").notNull().references(() => orgs.id, { onDelete: "cascade" }),
  projectId: text("project_id").references(() => projects.id, { onDelete: "cascade" }),
  service: text("service"),
  feature: text("feature").notNull(),
  enabled: boolean("enabled").notNull().default(true),
  updatedBy: text("updated_by").references(() => users.id, { onDelete: "set null" }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({ orgIdx: index("data_controls_org_idx").on(t.orgId) }));

// Sensitive-data filter patterns (design 19.2). built_in rows only carry the
// enabled override of a built-in pattern; its regex lives in code.
export const filterPatterns = pgTable("filter_patterns", {
  id: id(),
  orgId: text("org_id").notNull().references(() => orgs.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  pattern: text("pattern").notNull().default(""),
  enabled: boolean("enabled").notNull().default(true),
  builtIn: boolean("built_in").notNull().default(false),
  updatedBy: text("updated_by").references(() => users.id, { onDelete: "set null" }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({ orgNameUniq: uniqueIndex("filter_patterns_org_name_uniq").on(t.orgId, t.name) }));
