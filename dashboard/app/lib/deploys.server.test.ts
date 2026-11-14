import { describe, expect, test } from "bun:test";
import { handleDeployIngest, type DeployIngestDeps, type ValidDeploy } from "./deploys.server";

const NOW = Date.UTC(2026, 10, 14, 12, 0, 0);
const TOKEN = "bw_test_token";

function deps(over: Partial<DeployIngestDeps> = {}) {
  const stored: Array<{ orgId: string; projectId: string | null; deploys: readonly ValidDeploy[] }> = [];
  const keys: string[] = [];
  const d: DeployIngestDeps = {
    resolveToken: async (t) => (t === TOKEN ? { orgId: "org-1", projectId: "proj-1" } : null),
    names: async () => new Map([["bwinsshared-shop-api-1", "shop-api"]]),
    record: async (orgId, projectId, deploys) => {
      stored.push({ orgId, projectId, deploys });
      return deploys.length;
    },
    limit: (key) => {
      keys.push(key);
      return { ok: true, retryAfter: 0 };
    },
    now: () => NOW,
    ...over,
  };
  return { d, stored, keys };
}

function post(body: string, token: string | null = TOKEN, method = "POST"): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token !== null) headers.authorization = `Bearer ${token}`;
  return new Request("http://localhost/ingest/deploys", { method, headers, body: method === "GET" ? undefined : body });
}

describe("POST /ingest/deploys", () => {
  test("stores a report under the token's org and project, with the service's own name", async () => {
    const { d, stored, keys } = deps();
    const res = await handleDeployIngest(post(JSON.stringify({ service: "bwinsshared-shop-api-1", version: "v1" })), d);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ accepted: 1 });
    expect(stored[0].orgId).toBe("org-1");
    expect(stored[0].projectId).toBe("proj-1");
    expect(stored[0].deploys[0]).toMatchObject({ service: "shop-api", version: "v1", atMs: NOW });
    expect(keys).toEqual(["deploy:proj-1"]);
  });
  test("401 without or with a wrong token, 405 on other methods", async () => {
    const { d, stored } = deps();
    expect((await handleDeployIngest(post('{"service":"a"}', null), d)).status).toBe(401);
    const wrong = await handleDeployIngest(post('{"service":"a"}', "nope"), d);
    expect(wrong.status).toBe(401);
    expect(await wrong.json()).toEqual({ error: "unauthorized" });
    expect((await handleDeployIngest(post("", TOKEN, "GET"), d)).status).toBe(405);
    expect(stored).toHaveLength(0);
  });
  test("400 on bad JSON, bad fields, future at and more than 20", async () => {
    const { d, stored } = deps();
    expect((await handleDeployIngest(post("{nope"), d)).status).toBe(400);
    expect((await handleDeployIngest(post('{"version":"v1"}'), d)).status).toBe(400);
    expect((await handleDeployIngest(post(JSON.stringify({ service: "a", at: new Date(NOW + 3600_000).toISOString() })), d)).status).toBe(400);
    const many = { deploys: Array.from({ length: 21 }, (_, i) => ({ service: "a", commit: String(i) })) };
    const res = await handleDeployIngest(post(JSON.stringify(many)), d);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "deploys: at most 20 per call, got 21" });
    expect(stored).toHaveLength(0);
  });
  test("429 with retry-after once the project's hourly limit is used", async () => {
    const { d, stored } = deps({ limit: () => ({ ok: false, retryAfter: 1234 }) });
    const res = await handleDeployIngest(post('{"service":"a"}'), d);
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("1234");
    expect(stored).toHaveLength(0);
  });
  test("the name map failing keeps the name as sent", async () => {
    const { d, stored } = deps({ names: async () => { throw new Error("loki down"); } });
    expect((await handleDeployIngest(post('{"service":"bwinsshared-shop-api-1"}'), d)).status).toBe(200);
    expect(stored[0].deploys[0].service).toBe("bwinsshared-shop-api-1");
  });
  test("accepted counts what the store added (duplicates ignored there)", async () => {
    const { d } = deps({ record: async () => 1 });
    const res = await handleDeployIngest(post(JSON.stringify({ deploys: [{ service: "a", commit: "x" }, { service: "a", commit: "x" }] })), d);
    expect(await res.json()).toEqual({ accepted: 1 });
  });
});

// The table and the API read are SQL, so this part runs against a real Postgres:
// DATABASE_URL=<url> USAGE_TEST_DATABASE_URL=<url> bun test <this file>
const url = process.env.USAGE_TEST_DATABASE_URL;
const ready = !!url && process.env.DATABASE_URL === url;

describe("deploys table", () => {
  test.skipIf(!ready)("records, ignores a repeated commit, reads in order and filters", async () => {
    const { db, ensureSchema } = await import("~/db/index.server");
    const { sql } = await import("drizzle-orm");
    const { recordDeploys, deploysBetween, latestDeploy, listDeploys, deleteDeploy } = await import("./deploys.server");
    await ensureSchema();
    const org = `deploy-test-${Date.now()}`;
    await db.execute(sql`INSERT INTO orgs (id, name, slug) VALUES (${org}, 'Deploy test', ${org})`);
    const base = { version: null, commit: null, environment: null, url: null, actor: null };
    try {
      const added = await recordDeploys(org, null, [
        { ...base, service: "shop-api", version: "v2", commit: "bbb", atMs: NOW - 60_000 },
        { ...base, service: "shop-api", version: "v1", commit: "aaa", atMs: NOW - 3600_000 },
        { ...base, service: "shop-api", version: "v1 again", commit: "aaa", atMs: NOW - 1000 },
        { ...base, service: "other-api", commit: "aaa", atMs: NOW - 30_000 },
        { ...base, service: "shop-api", atMs: NOW - 10_000 },
        { ...base, service: "shop-api", atMs: NOW - 10_000 },
      ]);
      // the repeated commit of shop-api is ignored; the same commit on another service and
      // reports without a commit are kept
      expect(added).toBe(5);
      const shop = await deploysBetween(org, "shop-api", NOW - 2 * 3600_000, NOW);
      expect(shop.map((d) => d.version)).toEqual(["v1", "v2", null, null]);
      expect(shop.map((d) => d.deployedAt)).toEqual([NOW - 3600_000, NOW - 60_000, NOW - 10_000, NOW - 10_000]);
      expect((await deploysBetween(org, null, NOW - 120_000, NOW)).map((d) => d.service)).toEqual(["shop-api", "other-api", "shop-api", "shop-api"]);
      expect(await deploysBetween(org, "shop-api", NOW - 5000, NOW)).toEqual([]);
      expect((await latestDeploy(org, "other-api"))?.commit).toBe("aaa");
      expect(await latestDeploy(org, "nothing")).toBeNull();
      const listed = await listDeploys(org, { service: "shop-api", sinceMs: NOW - 120_000, limit: 2 });
      expect(listed).toHaveLength(2);
      expect(listed.every((d) => d.deployedAt >= NOW - 120_000 && d.service === "shop-api")).toBe(true);
      expect(await listDeploys(org, { service: null, sinceMs: null, limit: 50 })).toHaveLength(5);
      // deletes are per org
      expect(await deleteDeploy("another-org", listed[0].id)).toBe(false);
      expect(await deleteDeploy(org, listed[0].id)).toBe(true);
      expect(await listDeploys(org, { service: null, sinceMs: null, limit: 50 })).toHaveLength(4);
    } finally {
      await db.execute(sql`DELETE FROM orgs WHERE id = ${org}`);
    }
  });

  test.skipIf(!ready)("GET /api/v1/deploys: key required, filters, bad parameters", async () => {
    const { db, ensureSchema } = await import("~/db/index.server");
    const { sql } = await import("drizzle-orm");
    const { recordDeploys } = await import("./deploys.server");
    const { hashToken } = await import("~/lib/tenant.server");
    const { loader } = await import("~/routes/api.v1.deploys");
    await ensureSchema();
    const org = `deploy-api-test-${Date.now()}`;
    const key = `bwk_${org}`;
    await db.execute(sql`INSERT INTO orgs (id, name, slug) VALUES (${org}, 'Deploy API test', ${org})`);
    await db.execute(sql`INSERT INTO api_keys (id, org_id, name, key_hash) VALUES (${org}, ${org}, 'test', ${hashToken(key)})`);
    const base = { version: null, commit: null, environment: null, url: null, actor: null };
    const call = async (q: string, auth: string | null = key): Promise<Response> => {
      const headers: Record<string, string> = auth ? { authorization: `Bearer ${auth}` } : {};
      try {
        return await loader({ request: new Request(`http://localhost/api/v1/deploys${q}`, { headers }), params: {}, context: {} });
      } catch (e) {
        if (e instanceof Response) return e;
        throw e;
      }
    };
    try {
      await recordDeploys(org, null, [
        { ...base, service: "shop-api", version: "v1", atMs: NOW - 3600_000 },
        { ...base, service: "shop-api", version: "v2", commit: "c2", atMs: NOW - 60_000 },
        { ...base, service: "other-api", version: "o1", atMs: NOW - 30_000 },
      ]);
      expect((await call("", null)).status).toBe(401);
      const all = await call("");
      expect(all.status).toBe(200);
      const body = (await all.json()) as { deploys: Array<{ service: string; version: string; deployed_at: string; commit: string | null }>; count: number };
      expect(body.count).toBe(3);
      expect(body.deploys.map((d) => d.version)).toEqual(["o1", "v2", "v1"]);
      expect(body.deploys[1]).toMatchObject({ service: "shop-api", commit: "c2", deployed_at: new Date(NOW - 60_000).toISOString() });
      const shop = (await (await call("?service=shop-api&limit=1")).json()) as { deploys: Array<{ version: string }> };
      expect(shop.deploys.map((d) => d.version)).toEqual(["v2"]);
      const since = (await (await call(`?since=${encodeURIComponent(new Date(NOW - 120_000).toISOString())}`)).json()) as { count: number };
      expect(since.count).toBe(2);
      expect((await call("?limit=0")).status).toBe(400);
      expect((await call("?limit=500")).status).toBe(400);
      expect((await call("?since=soon")).status).toBe(400);
      expect((await call("?service=has%20space")).status).toBe(400);
    } finally {
      await db.execute(sql`DELETE FROM orgs WHERE id = ${org}`);
    }
  });
});
