// BAC-89: every reader scopes to the chosen project as well as the org.
import { describe, expect, test } from "bun:test";
import { metricInstant, scoped } from "./loki.server";
import { applyScope } from "./vm.server";
import { scopeMatchers, tenantKey, tenantOf } from "./tenant.server";

process.env.PLATFORM_ORG_ID = "platform-org";

describe("tenantOf / scopeMatchers / tenantKey", () => {
  test("org only, org + project, platform", () => {
    expect(scopeMatchers(tenantOf("o1"))).toEqual(['org_id="o1"']);
    expect(scopeMatchers(tenantOf("o1", "production"))).toEqual(['org_id="o1"', 'project="production"']);
    expect(scopeMatchers(tenantOf("platform-org", "dev"))).toEqual([]);
    expect(tenantOf("platform-org", "dev").project).toBeUndefined();
  });
  test("cache keys differ per project", () => {
    expect(tenantKey(tenantOf("o1"))).toBe("o1");
    expect(tenantKey(tenantOf("o1", "dev"))).toBe("o1/dev");
    expect(tenantKey(tenantOf("o1", "production"))).not.toBe(tenantKey(tenantOf("o1", "dev")));
    expect(tenantKey(tenantOf("platform-org"))).toBe("platform");
  });
});

describe("Loki selectors carry the project", () => {
  test("every selector, not just the first", () => {
    const q = scoped('sum(count_over_time({kind="hop"}[5m])) / sum(count_over_time({service="a"} |= "{x}" [5m]))', tenantOf("o1", "dev"));
    expect(q).toBe('sum(count_over_time({org_id="o1",project="dev",kind="hop"}[5m])) / sum(count_over_time({org_id="o1",project="dev",service="a"} |= "{x}" [5m]))');
  });
  test("an empty selector and the org-only scope", () => {
    expect(scoped("{}", tenantOf("o1", "production"))).toBe('{org_id="o1",project="production"}');
    expect(scoped('{kind="hop"}', tenantOf("o1"))).toBe('{org_id="o1",kind="hop"}');
  });
  test("metricInstant sends the project-scoped query", async () => {
    const urls: string[] = [];
    const fetcher = async <T,>(url: string): Promise<T> => {
      urls.push(url);
      return { status: "success", data: { resultType: "matrix", result: [] } } as T;
    };
    await metricInstant('sum(count_over_time({kind="hop"}[1h]))', { start: 0, end: 3600_000 }, tenantOf("o1", "production"), 1000, fetcher);
    expect(new URL(urls[0]).searchParams.get("query")).toBe('sum(count_over_time({org_id="o1",project="production",kind="hop"}[1h]))');
  });
});

describe("VictoriaMetrics queries carry the project", () => {
  test("extra_filters has org and project", () => {
    const p = applyScope(new URLSearchParams({ query: "up" }), tenantOf("o1", "dev"));
    expect(p.getAll("extra_filters[]")).toEqual(['{org_id="o1",project="dev"}']);
  });
  test("org only without a project, nothing for the platform", () => {
    expect(applyScope(new URLSearchParams(), tenantOf("o1")).getAll("extra_filters[]")).toEqual(['{org_id="o1"}']);
    expect(applyScope(new URLSearchParams(), tenantOf("platform-org", "dev")).getAll("extra_filters[]")).toEqual([]);
  });
});
