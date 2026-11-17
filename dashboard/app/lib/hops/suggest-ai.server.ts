// The AI write-up, server half (BAC-93). SWITCHED OFF by default: `aiWriteUp` reads the
// organisation's settings first and returns before it touches a client, a key or the network
// unless the switch is on, the monthly cap is above zero and a key exists. No key is configured
// on any server today, so `defaultAiClient()` returns null and no request can be made.
import { eq, sql } from "drizzle-orm";
import { db, ensureSchema } from "~/db/index.server";
import { suggestionAnswers, suggestionSettings } from "~/db/schema";
import { config } from "~/lib/config.server";
import {
  AI_DEFAULT_SETTINGS,
  AiStatus,
  answerKey,
  buildAiPayload,
  monthOf,
  settingsAt,
  withinCap,
  type AiInput,
  type AiPayload,
  type AiSettings,
} from "./suggest-ai";

/** The one thing a model client does. A test passes a stub. */
export interface AiClient {
  complete(payload: AiPayload): Promise<string>;
}

/** Where settings, kept answers and the month's count live. */
export interface AiStore {
  settings(orgId: string): Promise<AiSettings>;
  answer(orgId: string, key: string): Promise<string | null>;
  save(orgId: string, key: string, answer: string, model: string): Promise<void>;
  /** Count one write-up against the month. */
  recordUse(orgId: string, month: string): Promise<void>;
}

export type AiResult =
  | { status: typeof AiStatus.Answered; text: string; cached: boolean }
  | { status: Exclude<AiStatus, typeof AiStatus.Answered> };

export interface AiDeps {
  store: AiStore;
  /** Null when no key is configured. Not called unless the switch, the cap and a kept answer allow it. */
  client: AiClient | null;
  model: string;
  now: number;
}

/** Write up one shape: off first, then a kept answer, then the key, then the cap, then the call. */
export async function aiWriteUp(deps: AiDeps, orgId: string, input: AiInput): Promise<AiResult> {
  const settings = settingsAt(await deps.store.settings(orgId), deps.now);
  if (!settings.enabled) return { status: AiStatus.Off };
  const key = answerKey(input.statement, input.figures);
  const kept = await deps.store.answer(orgId, key);
  if (kept !== null) return { status: AiStatus.Answered, text: kept, cached: true };
  if (!deps.client) return { status: AiStatus.NoKey };
  if (!withinCap(settings)) return { status: AiStatus.OverCap };
  const payload = buildAiPayload(input, deps.model);
  try {
    const text = await deps.client.complete(payload);
    await deps.store.save(orgId, key, text, deps.model);
    await deps.store.recordUse(orgId, monthOf(deps.now));
    return { status: AiStatus.Answered, text, cached: false };
  } catch {
    return { status: AiStatus.Failed };
  }
}

// ---------------------------------------------------------------- the model client (not used while off)

/** What the Messages API returns that we read. */
interface MessagesResponse {
  content?: Array<{ type?: string; text?: string }>;
}

function isMessagesResponse(v: unknown): v is MessagesResponse {
  return typeof v === "object" && v !== null;
}

/** A client for the Messages API over `fetch`. Built only when a key exists; never built today. */
export function httpAiClient(apiKey: string, fetchImpl: typeof fetch = fetch): AiClient {
  return {
    async complete(payload) {
      const res = await fetchImpl("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({ model: payload.model, max_tokens: 400, system: payload.system, messages: [{ role: "user", content: payload.user }] }),
      });
      if (!res.ok) throw new Error(`model call failed: ${res.status}`);
      const body: unknown = await res.json();
      const text = isMessagesResponse(body) ? body.content?.find((c) => c.type === "text")?.text : undefined;
      if (!text) throw new Error("model call returned no text");
      return text;
    },
  };
}

/** The client for this server: null while no key is set, which is the case on every deployment today. */
export function defaultAiClient(env: NodeJS.ProcessEnv = process.env): AiClient | null {
  const key = env.SUGGEST_AI_API_KEY ?? "";
  return key ? httpAiClient(key) : null;
}

export function aiKeyConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.SUGGEST_AI_API_KEY ?? "") !== "";
}

// ---------------------------------------------------------------- Postgres store

export const pgAiStore: AiStore = {
  async settings(orgId) {
    await ensureSchema();
    const [r] = await db.select().from(suggestionSettings).where(eq(suggestionSettings.orgId, orgId)).limit(1);
    return r ? { enabled: r.aiEnabled, monthlyCap: r.aiMonthlyCap, used: r.aiUsed, month: r.aiUsedMonth } : AI_DEFAULT_SETTINGS;
  },
  async answer(orgId, key) {
    await ensureSchema();
    const [r] = await db.select({ answer: suggestionAnswers.answer }).from(suggestionAnswers).where(sql`${suggestionAnswers.orgId} = ${orgId} and ${suggestionAnswers.key} = ${key}`).limit(1);
    return r?.answer ?? null;
  },
  async save(orgId, key, answer, model) {
    await ensureSchema();
    await db.insert(suggestionAnswers).values({ orgId, key, answer, model }).onConflictDoUpdate({ target: [suggestionAnswers.orgId, suggestionAnswers.key], set: { answer, model, createdAt: new Date() } });
  },
  async recordUse(orgId, month) {
    await ensureSchema();
    await db
      .insert(suggestionSettings)
      .values({ orgId, aiUsedMonth: month, aiUsed: 1 })
      .onConflictDoUpdate({
        target: suggestionSettings.orgId,
        set: { aiUsed: sql`case when ${suggestionSettings.aiUsedMonth} = ${month} then ${suggestionSettings.aiUsed} + 1 else 1 end`, aiUsedMonth: month },
      });
  },
};

/** What the Settings card shows and saves. */
export async function loadAiSettings(orgId: string, now: number = Date.now()): Promise<AiSettings> {
  return settingsAt(await pgAiStore.settings(orgId), now);
}

export async function saveAiSettings(orgId: string, userId: string, enabled: boolean, monthlyCap: number): Promise<void> {
  await ensureSchema();
  const cap = Math.max(0, Math.min(10_000, Math.floor(monthlyCap)));
  await db
    .insert(suggestionSettings)
    .values({ orgId, aiEnabled: enabled, aiMonthlyCap: cap, updatedBy: userId, updatedAt: new Date() })
    .onConflictDoUpdate({ target: suggestionSettings.orgId, set: { aiEnabled: enabled, aiMonthlyCap: cap, updatedBy: userId, updatedAt: new Date() } });
}

/** The default dependencies of a real call: Postgres, the key from the environment (none today). */
export function defaultAiDeps(now: number = Date.now()): AiDeps {
  return { store: pgAiStore, client: defaultAiClient(), model: config.suggestAiModel, now };
}
