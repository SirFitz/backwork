import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "./schema";
import { survivePoolErrors } from "./pool-errors.server";

const pool = survivePoolErrors(
  new pg.Pool({
    connectionString: process.env.DATABASE_URL || "postgresql://backwork:backwork_dev_pw@postgres:5432/backwork",
    max: 8,
  }),
);

export const db = drizzle(pool, { schema });

// Idempotent schema bootstrap. Greenfield app, so CREATE TABLE IF NOT EXISTS on
// boot is simpler + more reliable on Coolify than a separate migration step.
const DDL = `
CREATE TABLE IF NOT EXISTS users (
  id text PRIMARY KEY, email text NOT NULL, name text NOT NULL DEFAULT '',
  password_hash text NOT NULL, is_platform_admin boolean NOT NULL DEFAULT false,
  email_verified_at timestamptz, last_login_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
CREATE UNIQUE INDEX IF NOT EXISTS users_email_uniq ON users (lower(email));
ALTER TABLE users ADD COLUMN IF NOT EXISTS token_version integer NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS orgs (
  id text PRIMARY KEY, name text NOT NULL, slug text NOT NULL,
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
CREATE UNIQUE INDEX IF NOT EXISTS orgs_slug_uniq ON orgs (slug);

ALTER TABLE orgs ADD COLUMN IF NOT EXISTS plan text NOT NULL DEFAULT 'unmetered';
ALTER TABLE orgs ADD COLUMN IF NOT EXISTS requests_limit integer;
ALTER TABLE orgs ADD COLUMN IF NOT EXISTS storage_limit_bytes bigint;

DROP TABLE IF EXISTS org_usage;
CREATE TABLE IF NOT EXISTS org_buckets (
  org_id text NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  bucket bigint NOT NULL,
  requests bigint NOT NULL DEFAULT 0,
  bytes bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (org_id, bucket));

CREATE TABLE IF NOT EXISTS memberships (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  org_id text NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  role text NOT NULL DEFAULT 'member',
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
CREATE UNIQUE INDEX IF NOT EXISTS memberships_user_org_uniq ON memberships (user_id, org_id);
CREATE INDEX IF NOT EXISTS memberships_org_idx ON memberships (org_id);

CREATE TABLE IF NOT EXISTS teams (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  name text NOT NULL, slug text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
CREATE UNIQUE INDEX IF NOT EXISTS teams_org_slug_uniq ON teams (org_id, slug);

CREATE TABLE IF NOT EXISTS team_members (
  id text PRIMARY KEY,
  team_id text NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
CREATE UNIQUE INDEX IF NOT EXISTS team_members_team_user_uniq ON team_members (team_id, user_id);

CREATE TABLE IF NOT EXISTS projects (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  name text NOT NULL, slug text NOT NULL, ingest_token_hash text,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
CREATE UNIQUE INDEX IF NOT EXISTS projects_org_slug_uniq ON projects (org_id, slug);
CREATE INDEX IF NOT EXISTS projects_ingest_token_hash_idx ON projects (ingest_token_hash);

CREATE TABLE IF NOT EXISTS invitations (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  email text NOT NULL, role text NOT NULL DEFAULT 'member', token text NOT NULL,
  invited_by_user_id text REFERENCES users(id) ON DELETE SET NULL,
  accepted_at timestamptz, expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now());
CREATE UNIQUE INDEX IF NOT EXISTS invitations_token_uniq ON invitations (token);
CREATE INDEX IF NOT EXISTS invitations_org_email_idx ON invitations (org_id, email);

CREATE TABLE IF NOT EXISTS alert_rules (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  data jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS alert_rules_org_idx ON alert_rules (org_id);

CREATE TABLE IF NOT EXISTS alert_channels (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  data jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS alert_channels_org_idx ON alert_channels (org_id);

-- trace_services held the service names of OpenTelemetry span ingest, removed in BAC-49.
DROP TABLE IF EXISTS trace_services;

CREATE TABLE IF NOT EXISTS peer_services (
  org_id text NOT NULL, peer text NOT NULL, service text NOT NULL,
  last_seen timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, peer, service));

CREATE TABLE IF NOT EXISTS migrations (
  name text PRIMARY KEY, at timestamptz NOT NULL DEFAULT now());

CREATE TABLE IF NOT EXISTS password_resets (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL, expires_at timestamptz NOT NULL, used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now());
CREATE UNIQUE INDEX IF NOT EXISTS password_resets_token_uniq ON password_resets (token_hash);

CREATE TABLE IF NOT EXISTS audit_log (
  id text PRIMARY KEY,
  org_id text REFERENCES orgs(id) ON DELETE CASCADE,
  actor_user_id text REFERENCES users(id) ON DELETE SET NULL,
  action text NOT NULL, target jsonb DEFAULT '{}'::jsonb, ip text,
  created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS audit_log_org_idx ON audit_log (org_id);

CREATE TABLE IF NOT EXISTS error_groups (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  project text NOT NULL DEFAULT '',
  fingerprint text NOT NULL,
  type text NOT NULL DEFAULT 'Error',
  message text NOT NULL DEFAULT '',
  service text NOT NULL DEFAULT '',
  level text NOT NULL DEFAULT 'error',
  status text NOT NULL DEFAULT 'open',
  count integer NOT NULL DEFAULT 0,
  sample jsonb DEFAULT '{}'::jsonb,
  first_seen timestamptz NOT NULL DEFAULT now(),
  last_seen timestamptz NOT NULL DEFAULT now());
CREATE UNIQUE INDEX IF NOT EXISTS error_groups_org_fp_uniq ON error_groups (org_id, fingerprint);
CREATE INDEX IF NOT EXISTS error_groups_org_last_idx ON error_groups (org_id, last_seen);
CREATE TABLE IF NOT EXISTS error_events (
  id text PRIMARY KEY,
  group_id text NOT NULL REFERENCES error_groups(id) ON DELETE CASCADE,
  org_id text NOT NULL,
  payload jsonb DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS error_events_group_idx ON error_events (group_id, created_at);

CREATE TABLE IF NOT EXISTS api_keys (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  name text NOT NULL DEFAULT '',
  key_hash text NOT NULL,
  created_by_user_id text REFERENCES users(id) ON DELETE SET NULL,
  last_used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS api_keys_org_idx ON api_keys (org_id);
CREATE UNIQUE INDEX IF NOT EXISTS api_keys_hash_uniq ON api_keys (key_hash);

CREATE TABLE IF NOT EXISTS data_controls (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  project_id text REFERENCES projects(id) ON DELETE CASCADE,
  service text,
  feature text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  updated_by text REFERENCES users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now());
CREATE UNIQUE INDEX IF NOT EXISTS data_controls_scope_uniq
  ON data_controls (org_id, (coalesce(project_id, '')), (coalesce(service, '')), feature);
CREATE INDEX IF NOT EXISTS data_controls_org_idx ON data_controls (org_id);

CREATE TABLE IF NOT EXISTS filter_patterns (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  name text NOT NULL,
  pattern text NOT NULL DEFAULT '',
  enabled boolean NOT NULL DEFAULT true,
  built_in boolean NOT NULL DEFAULT false,
  updated_by text REFERENCES users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now());
CREATE UNIQUE INDEX IF NOT EXISTS filter_patterns_org_name_uniq ON filter_patterns (org_id, name);
`;

declare global {
  // eslint-disable-next-line no-var
  var __bwSchemaReady: Promise<void> | undefined;
}

export function ensureSchema(): Promise<void> {
  if (!globalThis.__bwSchemaReady) {
    globalThis.__bwSchemaReady = pool.query(DDL).then(() => undefined).catch((e) => {
      globalThis.__bwSchemaReady = undefined; // allow retry on next call
      throw e;
    });
  }
  return globalThis.__bwSchemaReady;
}
