// BAC-75 evidence: real hop records from the fixture Loki through parse, split, tree and diff.
const WT = "/Users/romario/projects/inkress/backwork-wt/ins-diff/dashboard/app/lib/hops";
const { parseHopRecord } = await import(`${WT}/parse.ts`);
const { splitRequests } = await import(`${WT}/split.ts`);
const { buildRequestTree } = await import(`${WT}/tree.ts`);
const { diffRequests, fmtDeltaUs } = await import(`${WT}/diff.ts`);
const { fmtUs } = await import(`${WT}/time-format.ts`);

const LOKI = "http://localhost:3191";
const now = Date.now();

async function q(query: string, startMs: number, endMs: number, limit: number): Promise<Array<{ ts: number; line: string; labels: Record<string, string> }>> {
  const u = new URL(`${LOKI}/loki/api/v1/query_range`);
  u.searchParams.set("query", query);
  u.searchParams.set("start", `${Math.floor(startMs)}000000`);
  u.searchParams.set("end", `${Math.ceil(endMs)}000000`);
  u.searchParams.set("limit", String(limit));
  const j = (await (await fetch(u)).json()) as { data: { result: Array<{ stream: Record<string, string>; values: [string, string][] }> } };
  return j.data.result.flatMap((s) => s.values.map(([ns, line]) => ({ ts: Number(BigInt(ns) / 1000n) / 1000, line, labels: s.stream })));
}

async function heads(route: string) {
  const es = await q(`{service="shop-api",kind="hop"} |= "in_end" |= ${JSON.stringify(route)}`, now - 3600_000, now, 200);
  return es.map((e) => parseHopRecord(e)).filter((r: any) => r && r.hop === "in_end" && r.op === route && r.durationUs !== null)
    .map((r: any) => ({ traceId: r.traceId as string, ms: r.durationUs / 1000 }));
}

async function tree(traceId: string) {
  const es = await q(`{kind="hop"} |= "${traceId}"`, now - 3600_000, now, 5000);
  const recs = es.map((e) => parseHopRecord(e)).filter((r: any) => r && r.traceId === traceId);
  const parts = splitRequests(recs, [], []);
  return { tree: buildRequestTree(parts[0].records, [], now, parts[0].links, null), truncated: es.length >= 5000, n: recs.length };
}

function median(xs: number[]): number { const s = [...xs].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; }

async function compare(title: string, a: string, b: string) {
  const [ta, tb] = await Promise.all([tree(a), tree(b)]);
  const d = diffRequests(ta.tree, tb.tree, { aTruncated: ta.truncated, bTruncated: tb.truncated });
  console.log(`\n=== ${title}\nA ${a} (${ta.n} records)\nB ${b} (${tb.n} records)`);
  for (const s of d.sentences) console.log(`  ${s}`);
  for (const w of d.warnings) console.log(`  warning: ${w}`);
  console.log(`  split delta: db ${fmtDeltaUs(d.splitDelta.dbUs)}, cache ${fmtDeltaUs(d.splitDelta.cacheUs)}, waiting ${fmtDeltaUs(d.splitDelta.waitingUs)}, own ${fmtDeltaUs(d.splitDelta.ownUs)}`);
  console.log(`  top (${d.top.length}):`);
  for (const r of d.top) console.log(`    ${r.kind.padEnd(11)} ${r.label.padEnd(28)} A ${r.a ? `${fmtUs(r.a.durationUs)} x${r.a.calls}` : "-"}  B ${r.b ? `${fmtUs(r.b.durationUs)} x${r.b.calls}` : "-"}  contribution ${fmtDeltaUs(r.contributionUs)}`);
  console.log(`  rows: ${d.rows.length}, differing: ${d.rows.filter((r) => r.kind !== "same").length}`);
  for (const r of d.rows) console.log(`    ${"  ".repeat(r.depth)}${r.label} | ${r.a ? `${fmtUs(r.a.durationUs)} x${r.a.calls}` : "-"} | ${r.b ? `${fmtUs(r.b.durationUs)} x${r.b.calls}` : "-"} | ${r.kind}`);
}

const orders = await heads("/orders/:id");
const om = median(orders.map((o) => o.ms));
const slow = [...orders].sort((x, y) => y.ms - x.ms)[0];
const typical = [...orders].filter((o) => o.traceId !== slow.traceId).sort((x, y) => Math.abs(x.ms - om) - Math.abs(y.ms - om))[0];
const fast = [...orders].sort((x, y) => x.ms - y.ms)[0];
console.log(`GET /orders/:id: ${orders.length} requests in the last hour, median ${om.toFixed(1)} ms, slowest ${slow.ms.toFixed(1)} ms, fastest ${fast.ms.toFixed(1)} ms`);
await compare("GET /orders/:id slowest vs fastest", slow.traceId, fast.traceId);
await compare("GET /orders/:id slowest vs typical (nearest median)", slow.traceId, typical.traceId);
const shop = await heads("/shop");
const sm = median(shop.map((o) => o.ms));
const s2 = [...shop].sort((x, y) => Math.abs(x.ms - sm) - Math.abs(y.ms - sm));
console.log(`\nGET /shop: ${shop.length} requests in the last hour, median ${sm.toFixed(1)} ms`);
await compare("GET /shop two similar requests", s2[0].traceId, s2[1].traceId);
await compare("Different routes: GET /orders/:id vs GET /shop", slow.traceId, s2[0].traceId);
