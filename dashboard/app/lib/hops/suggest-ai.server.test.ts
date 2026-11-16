// BAC-93: the AI write-up is OFF. These tests use a stub client that counts calls: switched off, no
// key, a cap of zero and a kept answer all return without calling it, and the payload it would be
// given holds the shape only.
import { describe, expect, test } from "bun:test";
import { buildObservedSchema } from "./observed-schema";
import { NO_CONTEXT, SuggestionKind, type Suggestion } from "./suggest";
import { AI_DEFAULT_SETTINGS, AiStatus, AiPayloadError, aiStatusText, answerKey, buildAiPayload, figuresBucket, monthOf, settingsAt, withinCap, type AiFigures, type AiInput, type AiSettings } from "./suggest-ai";
import { aiWriteUp, defaultAiClient, httpAiClient, type AiClient, type AiPayload, type AiStore } from "./suggest-ai.server";
import { statementShape } from "./stmt-shape";

const NOW = Date.UTC(2026, 10, 16, 9, 0, 0);
const FIG: AiFigures = { calls: 4000, totalS: 900, p95S: 0.4, shareOfDb: 0.7 };
// A recorded statement with values in it: an email, a phone number, an amount.
const RAW = `SELECT "id" FROM "merchants" AS "m" INNER JOIN "orders" AS "o" ON "o"."merchant_id" = "m"."id" WHERE "m"."email" = 'ann.lee@example.com' AND "m"."phone" = '+18765550142' AND "o"."total" > 4242.50`;
const schema = buildObservedSchema([{ shape: statementShape(RAW), calls: 4000 }]);
const hit: Suggestion = {
  id: "x", kind: SuggestionKind.DominantShape, confidence: "likely", service: "commerce-api", table: "merchants", shapes: [statementShape(RAW)], hopIds: [],
  summary: "Index merchants (email, phone), likely", evidence: ["70 percent of commerce-api's database time"], advice: "", sketch: "create index on merchants (email, phone)", savedUs: null,
};
const input: AiInput = { statement: RAW, figures: FIG, schema, hits: [hit] };

function stubClient(): AiClient & { calls: AiPayload[] } {
  const calls: AiPayload[] = [];
  return { calls, async complete(p) { calls.push(p); return "It likely scans merchants; consider an index."; } };
}

function memoryStore(initial: AiSettings = AI_DEFAULT_SETTINGS): AiStore & { answers: Map<string, string>; settings0: AiSettings } {
  const answers = new Map<string, string>();
  const self = {
    answers,
    settings0: initial,
    async settings() { return self.settings0; },
    async answer(_o: string, k: string) { return answers.get(k) ?? null; },
    async save(_o: string, k: string, a: string) { answers.set(k, a); },
    async recordUse(_o: string, month: string) { self.settings0 = { ...self.settings0, month, used: (self.settings0.month === month ? self.settings0.used : 0) + 1 }; },
  };
  return self;
}

const on: AiSettings = { enabled: true, monthlyCap: 2, used: 0, month: monthOf(NOW) };

describe("the payload", () => {
  const p = buildAiPayload(input, "claude-sonnet-5-5");
  test("holds the shape, figures, schema around the tables and the rule hits", () => {
    expect(p.facts.shape).toBe(statementShape(RAW));
    expect(p.facts.figures).toEqual(FIG);
    expect(p.facts.tables.map((t) => t.name).sort()).toEqual(["merchants", "orders"]);
    expect(p.facts.relations[0].from).toContain("merchants.id");
    expect(p.facts.ruleHits[0].kind).toBe("dominant_shape");
  });
  test("holds no value: not the email, the phone, the amount or a quote", () => {
    const text = `${p.system}\n${p.user}`;
    for (const value of ["ann.lee", "example.com", "8765550142", "4242"]) expect(text).not.toContain(value);
    expect(p.facts.shape).not.toContain("'");
    expect(p.facts.shape).toContain("m.email = ?");
  });
  test("a shape that still has a literal is refused", () => {
    expect(() => buildAiPayload({ ...input, statement: RAW }, "m")).not.toThrow(); // statement is reduced to its shape first
    expect(() => buildAiPayload({ ...input, statement: "select 'x" }, "m")).toThrow(AiPayloadError);
  });
  test("the model comes from the argument (the config default is claude-sonnet-5-5)", () => {
    expect(p.model).toBe("claude-sonnet-5-5");
  });
});

describe("keys and buckets", () => {
  test("figures that move a little keep one answer; a big move is a new one", () => {
    expect(answerKey(RAW, FIG)).toBe(answerKey(RAW, { ...FIG, calls: 4100, totalS: 880 }));
    expect(answerKey(RAW, FIG)).not.toBe(answerKey(RAW, { ...FIG, calls: 40_000 }));
    expect(figuresBucket(FIG)).toMatch(/^c\d+-t\d+-p\d+-s\d+$/);
  });
  test("two statements that differ only by values share a key", () => {
    expect(answerKey(RAW, FIG)).toBe(answerKey(RAW.replace("ann.lee", "bob.ray"), FIG));
  });
});

describe("aiWriteUp", () => {
  test("off by default: no client call, nothing stored", async () => {
    const client = stubClient();
    const store = memoryStore();
    const r = await aiWriteUp({ store, client, model: "m", now: NOW }, "org", input);
    expect(r).toEqual({ status: AiStatus.Off });
    expect(client.calls).toHaveLength(0);
    expect(store.answers.size).toBe(0);
  });
  test("on but no key: nothing is sent", async () => {
    expect(await aiWriteUp({ store: memoryStore(on), client: null, model: "m", now: NOW }, "org", input)).toEqual({ status: AiStatus.NoKey });
  });
  test("on with a cap of zero: nothing is sent", async () => {
    const client = stubClient();
    const r = await aiWriteUp({ store: memoryStore({ ...on, monthlyCap: 0 }), client, model: "m", now: NOW }, "org", input);
    expect(r).toEqual({ status: AiStatus.OverCap });
    expect(client.calls).toHaveLength(0);
  });
  test("on with a key: one call, the answer kept, the month counted, the next ask served from the keep", async () => {
    const client = stubClient();
    const store = memoryStore(on);
    const deps = { store, client, model: "claude-sonnet-5-5", now: NOW };
    const first = await aiWriteUp(deps, "org", input);
    expect(first).toMatchObject({ status: AiStatus.Answered, cached: false });
    expect(client.calls).toHaveLength(1);
    expect(client.calls[0].model).toBe("claude-sonnet-5-5");
    expect(JSON.stringify(client.calls[0])).not.toContain("ann.lee");
    expect(store.settings0.used).toBe(1);
    const second = await aiWriteUp(deps, "org", input);
    expect(second).toMatchObject({ status: AiStatus.Answered, cached: true });
    expect(client.calls).toHaveLength(1);
  });
  test("the cap stops new shapes once used up; a new month resets the count", async () => {
    const client = stubClient();
    const store = memoryStore({ ...on, monthlyCap: 1, used: 1 });
    expect(await aiWriteUp({ store, client, model: "m", now: NOW }, "org", input)).toEqual({ status: AiStatus.OverCap });
    expect(withinCap(settingsAt({ ...on, monthlyCap: 1, used: 1 }, NOW + 40 * 86400_000))).toBe(true);
  });
  test("a failing model is reported, not thrown", async () => {
    const client: AiClient = { async complete() { throw new Error("boom"); } };
    expect(await aiWriteUp({ store: memoryStore(on), client, model: "m", now: NOW }, "org", input)).toEqual({ status: AiStatus.Failed });
  });
});

describe("the client", () => {
  test("no key in the environment means no client", () => {
    expect(defaultAiClient({})).toBeNull();
    expect(defaultAiClient({ SUGGEST_AI_API_KEY: "" })).toBeNull();
  });
  test("with a key it posts the payload once (stubbed fetch, no network)", async () => {
    const seen: Array<{ url: string; body: string }> = [];
    const fake = (async (url: string, init: { body: string }) => {
      seen.push({ url, body: init.body });
      return { ok: true, status: 200, json: async () => ({ content: [{ type: "text", text: "ok" }] }) };
    }) as unknown as typeof fetch;
    const out = await httpAiClient("test-key", fake).complete(buildAiPayload(input, "claude-sonnet-5-5"));
    expect(out).toBe("ok");
    expect(seen).toHaveLength(1);
    expect(seen[0].body).not.toContain("ann.lee");
    expect(seen[0].body).toContain("claude-sonnet-5-5");
  });
});

describe("the words", () => {
  test("off says it is off until the cost is approved", () => {
    expect(aiStatusText(AI_DEFAULT_SETTINGS, false)).toContain("switched off until Romario approves the cost");
    expect(aiStatusText({ ...on }, false)).toContain("no model key");
    expect(aiStatusText({ ...on, monthlyCap: 0 }, true)).toContain("cap of 0");
    expect(aiStatusText({ ...on, used: 1 }, true)).toContain("1 of 2");
  });
  test("no context is empty", () => {
    expect(NO_CONTEXT.rows).toEqual([]);
  });
});
