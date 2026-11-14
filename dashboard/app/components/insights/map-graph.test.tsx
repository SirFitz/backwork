// Renders the service map graph and list to HTML and checks what a person would see: every node,
// every drawn edge, boxes that do not overlap, keyboard-reachable buttons, and the list holding
// the same edges as the graph.
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { MapDetails, MapGraph } from "~/components/insights/map-graph";
import { MapList } from "~/components/insights/map-list";
import { PerfRange } from "~/lib/hops/figures";
import { NODE_HEIGHT_PX, NODE_WIDTH_PX, SelectionKind, activatesSelection, buildMap, type MapFigures } from "~/lib/hops/service-map";
import { Via } from "~/lib/hops/types";

const f = (rate: number, errorShare = 0): MapFigures => ({ rate, errorShare, p50: 0.01, p95: 0.04, p99: 0.08 });
// The shared fixture stack's calls (shop-api and commerce-api calling the commerce services,
// databases, Redis and a third party), with the peers learned from its records.
const MAP = buildMap({
  services: ["shop-api", "commerce-api", "commerce-payments", "commerce-risk", "commerce-worker"].map((service) => ({ service, figures: f(1) })),
  knownServices: ["shop-api", "commerce-api", "commerce-payments", "commerce-risk", "commerce-worker"],
  connections: [
    { service: "shop-api", peer: "payments.internal", via: Via.Http, figures: f(0.4) },
    { service: "shop-api", peer: "risk.internal", via: Via.Http, figures: f(0.4, 0.02) },
    { service: "shop-api", peer: "shop-db", via: Via.Db, figures: f(9) },
    { service: "shop-api", peer: "redis.internal", via: Via.Cache, figures: f(6) },
    { service: "commerce-api", peer: "payments.internal", via: Via.Http, figures: f(0.4, 0.07) },
    { service: "commerce-api", peer: "risk.internal", via: Via.Http, figures: f(0.5) },
    { service: "commerce-api", peer: "orders-db", via: Via.Db, figures: f(0.9) },
    { service: "commerce-api", peer: "receipts", via: Via.Job, figures: f(0.4) },
    { service: "commerce-api", peer: "notifications", via: Via.Job, figures: f(0.1) },
    { service: "commerce-payments", peer: "acquirer.example", via: Via.Http, figures: f(0.4) },
    { service: "commerce-payments", peer: "payments-db", via: Via.Db, figures: f(0.8) },
    { service: "commerce-risk", peer: "redis.internal", via: Via.Cache, figures: f(0.5) },
  ],
  peerServices: new Map([
    ["payments.internal", "commerce-payments"],
    ["risk.internal", "commerce-risk"],
    ["receipts", "commerce-worker"],
  ]),
});

const render = (el: JSX.Element): string => renderToStaticMarkup(<MemoryRouter>{el}</MemoryRouter>);
const attrs = (html: string, name: string): string[] => [...html.matchAll(new RegExp(`${name}="([^"]+)"`, "g"))].map((m) => m[1]);

describe("MapGraph", () => {
  const html = render(<MapGraph map={MAP} selected={null} onSelect={() => {}} />);

  test("draws every node and every drawn edge", () => {
    expect(attrs(html, "data-node").sort()).toEqual(MAP.nodes.map((n) => n.id).sort());
    expect(attrs(html, "data-edge").sort()).toEqual(MAP.edges.filter((e) => e.drawn).map((e) => e.id).sort());
    expect(attrs(html, "data-edge").length).toBe(12);
    for (const label of ["shop-api", "commerce-payments", "shop-db", "redis.internal", "acquirer.example"]) expect(html).toContain(`>${label}<`);
  });

  test("node boxes do not overlap", () => {
    const xs = attrs(html, "data-x").map(Number);
    const ys = attrs(html, "data-y").map(Number);
    expect(xs.length).toBe(MAP.nodes.length);
    for (let i = 0; i < xs.length; i++) {
      for (let j = i + 1; j < xs.length; j++) {
        const overlap = xs[i] < xs[j] + NODE_WIDTH_PX && xs[j] < xs[i] + NODE_WIDTH_PX && ys[i] < ys[j] + NODE_HEIGHT_PX && ys[j] < ys[i] + NODE_HEIGHT_PX;
        expect(overlap).toBe(false);
      }
    }
  });

  test("every node fits inside the drawing", () => {
    for (const n of MAP.nodes) {
      expect(n.x + NODE_WIDTH_PX).toBeLessThanOrEqual(MAP.width);
      expect(n.y + NODE_HEIGHT_PX).toBeLessThanOrEqual(MAP.height);
    }
    expect(html).toContain(`viewBox="0 0 ${MAP.width} ${MAP.height}"`);
  });

  test("nodes and edges are keyboard buttons; Enter and Space pick them", () => {
    const buttons = html.match(/role="button" tabindex="0"/g) ?? [];
    expect(buttons.length).toBe(MAP.nodes.length + 12);
    expect(activatesSelection("Enter")).toBe(true);
    expect(activatesSelection(" ")).toBe(true);
    expect(activatesSelection("Tab")).toBe(false);
  });

  test("error tone shows on the failing links only, and externals are dashed", () => {
    const risky = MAP.edges.find((e) => e.from === "svc:shop-api" && e.to === "svc:commerce-risk");
    const failing = MAP.edges.find((e) => e.from === "svc:commerce-api" && e.to === "svc:commerce-payments");
    expect(risky?.tone).toBe("warn");
    expect(failing?.tone).toBe("err");
    expect((html.match(/class="stroke-warn"/g) ?? []).length).toBe(1);
    expect((html.match(/class="stroke-err"/g) ?? []).length).toBe(1);
    expect(html).toContain('stroke-dasharray="3 3"');
  });

  test("a selected edge shows its p95 on the line", () => {
    const id = MAP.edges[0].id;
    const sel = render(<MapGraph map={MAP} selected={{ kind: SelectionKind.Edge, id }} onSelect={() => {}} />);
    expect(sel).toContain("p95 40 ms");
  });
});

describe("MapDetails", () => {
  test("a picked service lists its callers and callees with a link to Performance", () => {
    const html = render(<MapDetails map={MAP} selected={{ kind: SelectionKind.Node, id: "svc:commerce-payments" }} range={PerfRange.H1} />);
    expect(html).toContain("Called by");
    expect(html).toContain("shop-api");
    expect(html).toContain("commerce-api");
    expect(html).toContain("acquirer.example");
    expect(html).toContain('href="/performance?service=commerce-payments&amp;range=1h"');
  });

  test("a picked edge shows its figures and a link to the caller's requests", () => {
    const e = MAP.edges.find((x) => x.to === "store:shop-db");
    const html = render(<MapDetails map={MAP} selected={{ kind: SelectionKind.Edge, id: e?.id ?? "" }} range={PerfRange.H6} />);
    expect(html).toContain("shop-api to shop-db");
    expect(html).toContain('href="/requests?service=shop-api&amp;range=6h"');
  });
});

describe("MapList", () => {
  test("lists the same edges as the graph, grouped by caller", () => {
    const html = render(<MapList map={MAP} />);
    const listed = attrs(html, "data-edge");
    expect([...listed].sort()).toEqual(MAP.edges.map((e) => e.id).sort());
    const callers = listed.map((id) => id.split("|")[0]);
    const groups = callers.filter((c, i) => i === 0 || callers[i - 1] !== c);
    expect(new Set(groups).size).toBe(groups.length);
    expect(html).toContain(">database<");
    expect(html).toContain(">cache<");
    expect(html).toContain(">external<");
  });
});
