import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "./schema";

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL || "postgresql://backwork:backwork_dev_pw@postgres:5432/backwork",
  max: 8,
});

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

CREATE TABLE IF NOT EXISTS trace_services (
  org_id text NOT NULL, service text NOT NULL,
  last_seen timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, service));

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
