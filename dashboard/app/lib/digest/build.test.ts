import { describe, expect, test } from "bun:test";
import { DIGEST_LINE_MAX_CHARS, DigestSection, buildDigest, fmtBytes, spanText, type DigestInput } from "./build";
import { compareRow } from "~/lib/hops/compare";
import { FixKind, ItemTone, type FixItem } from "~/lib/insights/fix-first";
import type { Deploy } from "~/lib/deploys";

const NOW = Date.UTC(2026, 10, 16, 8, 5); // Monday 16 Nov 08:05 UTC
const WEEK = 7 * 86_400_000;

function fix(n: number, title = `GET /route${n}`): FixItem {
  return {
    id: `route:shop-api:${n}`,
    kind: FixKind.Route,
    title,
    mono: false,
    detail: title,
    service: "shop-api",
    impactS: 100 - n,
    impactLabel: `${100 - n}.00 s of request time in the last 6 hours`,
    impactShort: `${100 - n}.00 s`,
    why: "",
    href: "/requests",
    tone: ItemTone.Neutral,
  };
}

const figures = (p95: number, errorShare = 0) => ({ rate: 1, errorShare, p50: p95 / 2, p95, p99: p95 });

function deploy(i: number): Deploy {
  return { id: `d${i}`, projectId: null, service: "shop-api", version: `1.4.${i}`, commit: null, environment: null, url: null, actor: null, deployedAt: NOW - i * 3_600_000 };
}

function empty(over: Partial<DigestInput> = {}): DigestInput {
  return {
    orgName: "Fixture Org",
    now: NOW,
    weekStart: NOW - WEEK,
    insightsUrl: "https://backwork.dev/insights",
    settingsUrl: "https://backwork.dev/alerts",
    fixFirst: [],
    fixWindowPhrase: "last 6 hours",
    regressions: [],
    newRepeats: [],
    repeatsSampled: false,
    repeatsWindowPhrase: "last 6 hours",
    errorGroups: [],
    alertEvents: [],
    deploys: [],
    usage: null,
    unavailable: [],
    ...over,
  };
}

function full(): DigestInput {
  return empty({
    fixFirst: [1, 2, 3, 4, 5, 6].map((n) => fix(n)),
    regressions: [
      compareRow("shop-api", null, null, figures(0.48), figures(0.2), 5000, 4800),
      compareRow("commerce-risk", null, null, figures(0.05, 0.12), figures(0.05, 0.01), 900, 880),
      compareRow("commerce-payments", null, null, figures(0.05), figures(0.05), 900, 880),
    ],
    newRepeats: [{ label: "select plans", service: "shop-api", requests: 120, medianRepeats: 14, wastedUs: 38_000 }],
    errorGroups: [
      { type: "TypeError", message: "cannot read id", service: "shop-api", isNew: false, weekCount: 40 },
      { type: "DbError", message: "timeout", service: "commerce-risk", isNew: true, weekCount: 3 },
    ],
    alertEvents: [
      { rule: "Slow checkout", firedAt: NOW - 2 * 86_400_000, resolvedAt: NOW - 2 * 86_400_000 + 42 * 60_000 },
      { rule: "Error rate", firedAt: NOW - 20 * 60_000, resolvedAt: null },
    ],
    deploys: [1, 2, 3, 4].map(deploy),
    usage: { requests: 1_234_567, includedRequests: 2_000_000, bytes: 3_400_000_000, includedBytes: 20 * 1024 ** 3 },
  });
}

describe("buildDigest", () => {
  test("title names the organisation and the week (UTC)", () => {
    expect(buildDigest(empty()).title).toBe("backwork weekly: Fixture Org, week of 9 Nov");
  });

  test("every section in order when each has content", () => {
    const d = buildDigest(full());
    expect(d.sections.map((s) => s.key)).toEqual([
      DigestSection.FixFirst,
      DigestSection.Slower,
      DigestSection.Repeats,
      DigestSection.Errors,
      DigestSection.Alerts,
      DigestSection.Deploys,
      DigestSection.Usage,
    ]);
    expect(d.quiet).toBe(false);
    const titles = d.body.split("\n\n").map((b) => b.split("\n")[0]);
    expect(titles).toEqual(["Fix first (last 6 hours)", "Slower than last week", "Repeated calls (last 6 hours)", "Errors", "Alerts this week", "Deploys", "Usage"]);
  });

  test("section contents", () => {
    const d = buildDigest(full());
    const s = (k: DigestSection): string[] => d.sections.find((x) => x.key === k)?.lines ?? [];
    expect(s(DigestSection.FixFirst)).toHaveLength(5);
    expect(s(DigestSection.FixFirst)[0]).toBe("1. GET /route1 (shop-api): 99.00 s of request time in the last 6 hours");
    expect(s(DigestSection.Slower)).toEqual(["- shop-api: 2.4x slower, p95 480 ms, was 200 ms", "- commerce-risk: 11 points more errors, 12% failed, was 1%"]);
    expect(s(DigestSection.Repeats)).toEqual(["- select plans in shop-api: 14 times per request in 120 requests, could save 38.0 ms"]);
    expect(s(DigestSection.Errors)).toEqual(["- DbError: timeout (commerce-risk): new, 3 times this week", "- TypeError: cannot read id (shop-api): 40 times this week"]);
    expect(s(DigestSection.Alerts)[0]).toBe("2 alerts fired, 1 still firing. Longest: Slow checkout, 42 min.");
    expect(s(DigestSection.Alerts)[1]).toBe("- Error rate: fired 16 Nov 07:45 UTC, still firing");
    expect(s(DigestSection.Deploys)[0]).toBe("4 deploys to 1 service. Latest:");
    expect(s(DigestSection.Deploys)).toHaveLength(4);
    expect(s(DigestSection.Deploys)[1]).toBe("- shop-api 1.4.1, 16 Nov 07:05 UTC");
    expect(s(DigestSection.Usage)).toEqual(["This month so far: 1,234,567 of 2,000,000 requests, 3.2 GB of 20 GB of data included in the plan."]);
  });

  test("empty sections are omitted", () => {
    const d = buildDigest(empty({ deploys: [deploy(1)] }));
    expect(d.sections.map((s) => s.key)).toEqual([DigestSection.Deploys]);
    expect(d.body).toBe("Deploys\n1 deploy to 1 service.\n- shop-api 1.4.1, 16 Nov 07:05 UTC");
  });

  test("a quiet week still sends a short message", () => {
    const d = buildDigest(empty({ usage: { requests: 10, includedRequests: null, bytes: 2048, includedBytes: null } }));
    expect(d.quiet).toBe(true);
    expect(d.body).toBe(
      "All quiet this week: nothing to fix first, nothing slower than last week, no new errors, no alerts fired and no deploys.\n\nUsage\nThis month so far: 10 requests, 2 KB of data.",
    );
  });

  test("failed sources are named and the week is not called quiet", () => {
    const d = buildDigest(empty({ unavailable: ["slow queries", "errors"] }));
    expect(d.quiet).toBe(false);
    expect(d.body).toBe("Nothing to report from the sources that answered.\n\nNot available this week: slow queries, errors.");
    const withContent = buildDigest({ ...full(), unavailable: ["slow queries"] });
    expect(withContent.body.endsWith("\n\nNot available this week: slow queries.")).toBe(true);
  });

  test("sampled repeats say so", () => {
    const d = buildDigest({ ...full(), repeatsSampled: true });
    expect(d.sections.find((s) => s.key === DigestSection.Repeats)?.title).toBe("Repeated calls (last 6 hours, sampled, so at least these counts)");
  });

  test("lines stay short, long names are cut", () => {
    const long = "select orders.id, orders.total, orders.status, orders.created_at from orders where orders.customer_id = ? and orders.status in (?)";
    const d = buildDigest({ ...full(), fixFirst: [fix(1, long)] });
    for (const l of d.body.split("\n")) expect(l.length).toBeLessThanOrEqual(DIGEST_LINE_MAX_CHARS);
    expect(d.sections[0].lines[0]).toContain("...");
  });

  test("no em dashes, no emoji", () => {
    const d = buildDigest(full());
    for (const text of [d.title, d.body, d.emailText]) {
      expect(text).not.toContain("—");
      expect(/\p{Extended_Pictographic}/u.test(text)).toBe(false);
    }
  });

  test("email text: title, body, link and a footer", () => {
    const d = buildDigest(full());
    expect(d.emailText.startsWith(`${d.title}\n\n${d.body}\n\nOpen Insights: https://backwork.dev/insights\n\n`)).toBe(true);
    expect(d.emailText.endsWith("on the Alerts page: https://backwork.dev/alerts")).toBe(true);
    expect(d.link).toBe("https://backwork.dev/insights");
  });

  test("webhook sections are structured", () => {
    const d = buildDigest(full());
    expect(JSON.parse(JSON.stringify(d.sections))[1]).toEqual({
      key: "slower",
      title: "Slower than last week",
      lines: ["- shop-api: 2.4x slower, p95 480 ms, was 200 ms", "- commerce-risk: 11 points more errors, 12% failed, was 1%"],
    });
  });
});

describe("formatting", () => {
  test("bytes", () => {
    expect(fmtBytes(512)).toBe("512 B");
    expect(fmtBytes(3.4 * 1024 ** 2)).toBe("3.4 MB");
    expect(fmtBytes(20 * 1024 ** 3)).toBe("20 GB");
    expect(fmtBytes(250 * 1024 ** 3)).toBe("250 GB");
  });
  test("spans", () => {
    expect(spanText(42 * 60_000)).toBe("42 min");
    expect(spanText(185 * 60_000)).toBe("3 h 5 min");
    expect(spanText(3 * 86_400_000)).toBe("3 days");
  });
});
