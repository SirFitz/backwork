import { lookup } from "node:dns/promises";
import net from "node:net";
import { and, eq } from "drizzle-orm";
import { db, ensureSchema } from "~/db/index.server";
import { alertChannels } from "~/db/schema";
import { encryptSecret, decryptSecret } from "./crypto.server";

// SSRF guard: alert destinations are user-controlled URLs hit by the server
// (test button + background evaluator). Block anything that targets the host
// itself, the docker network, link-local/metadata, or other internal services.
function isPrivateV4(ip: string): boolean {
  const p = ip.split(".").map(Number);
  if (p.length !== 4 || p.some((n) => Number.isNaN(n))) return true;
  const [a, b] = p;
  return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}
function isPrivateV6(ip: string): boolean {
  const x = ip.toLowerCase().replace(/^\[|\]$/g, "");
  if (x === "::1" || x === "::" || x.startsWith("fc") || x.startsWith("fd") || x.startsWith("fe8") || x.startsWith("fe9") || x.startsWith("fea") || x.startsWith("feb")) return true;
  const m = x.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  return m ? isPrivateV4(m[1]) : false;
}
function ipIsPrivate(ip: string): boolean {
  return net.isIPv4(ip) ? isPrivateV4(ip) : isPrivateV6(ip);
}

/** Throws if the URL is not a safe, public http(s) destination. `allowHosts`
 *  restricts to specific public domains (Slack/Discord). */
async function assertSafeUrl(raw: string, allowHosts?: string[]): Promise<void> {
  let u: URL;
  try { u = new URL(raw); } catch { throw new Error("invalid URL"); }
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error("only http(s) URLs are allowed");
  const host = u.hostname.toLowerCase();
  if (allowHosts) {
    if (!allowHosts.some((h) => host === h || host.endsWith("." + h))) throw new Error(`host must be one of: ${allowHosts.join(", ")}`);
  } else if (host === "localhost" || host.endsWith(".local") || host.endsWith(".internal") || !host.includes(".")) {
    throw new Error("internal/single-label hosts are not allowed");
  }
  if (net.isIP(host)) {
    if (ipIsPrivate(host)) throw new Error("private/loopback IPs are not allowed");
    return;
  }
  const addrs = await lookup(host, { all: true }).catch(() => { throw new Error("DNS resolution failed"); });
  if (!addrs.length || addrs.some((a) => ipIsPrivate(a.address))) throw new Error("host resolves to a private/loopback address");
}

export type ChannelType = "webhook" | "slack" | "discord" | "email" | "sms";

export type Channel = {
  id: string;
  name: string;
  type: ChannelType;
  enabled: boolean;
  config: Record<string, string>;
};

export type FieldDef = { key: string; label: string; placeholder?: string; secret?: boolean };

export const CHANNEL_TYPES: Record<ChannelType, { label: string; hint: string; fields: FieldDef[] }> = {
  webhook: {
    label: "Webhook",
    hint: "POSTs a JSON payload to any URL.",
    fields: [{ key: "url", label: "POST URL", placeholder: "https://example.com/hooks/backwork" }],
  },
  slack: {
    label: "Slack",
    hint: "Slack incoming webhook (Slack app > Incoming Webhooks).",
    fields: [{ key: "webhookUrl", label: "Incoming webhook URL", placeholder: "https://hooks.slack.com/services/..." }],
  },
  discord: {
    label: "Discord",
    hint: "Discord channel webhook (Channel settings > Integrations > Webhooks).",
    fields: [{ key: "webhookUrl", label: "Webhook URL", placeholder: "https://discord.com/api/webhooks/..." }],
  },
  email: {
    label: "Email (SMTP)",
    hint: "Any SMTP provider (SES, Postmark, Gmail app password, etc.).",
    fields: [
      { key: "host", label: "SMTP host", placeholder: "smtp.example.com" },
      { key: "port", label: "Port", placeholder: "587" },
      { key: "user", label: "Username" },
      { key: "pass", label: "Password", secret: true },
      { key: "from", label: "From address", placeholder: "alerts@example.com" },
      { key: "to", label: "To address", placeholder: "you@example.com" },
    ],
  },
  sms: {
    label: "SMS (Twilio)",
    hint: "Twilio account SID + auth token.",
    fields: [
      { key: "sid", label: "Account SID" },
      { key: "token", label: "Auth token", secret: true },
      { key: "from", label: "From number", placeholder: "+1..." },
      { key: "to", label: "To number", placeholder: "+1..." },
    ],
  },
};

// Encrypt/decrypt the secret-flagged config fields of a channel in place (copy).
function cryptChannel(c: Channel, fn: (v: string) => string): Channel {
  const secrets = new Set((CHANNEL_TYPES[c.type]?.fields || []).filter((f) => f.secret).map((f) => f.key));
  const config: Record<string, string> = {};
  for (const [k, v] of Object.entries(c.config || {})) config[k] = secrets.has(k) ? fn(v) : v;
  return { ...c, config };
}

export async function loadChannels(orgId: string): Promise<Channel[]> {
  await ensureSchema();
  const rows = await db.select({ data: alertChannels.data }).from(alertChannels).where(eq(alertChannels.orgId, orgId));
  return rows.map((r) => cryptChannel(r.data as unknown as Channel, (v) => decryptSecret(v)));
}

export async function saveChannels(orgId: string, channels: Channel[]): Promise<void> {
  await ensureSchema();
  const encrypted = channels.map((c) => cryptChannel(c, (v) => encryptSecret(v)));
  await db.transaction(async (tx) => {
    await tx.delete(alertChannels).where(eq(alertChannels.orgId, orgId));
    if (encrypted.length) {
      await tx.insert(alertChannels).values(encrypted.map((c) => ({ id: c.id, orgId, data: c as unknown as Record<string, unknown> })));
    }
  });
}

// Granular single-row ops (avoid the read-all/save-all lost-update race — H8).
export async function insertChannel(orgId: string, c: Channel): Promise<void> {
  await ensureSchema();
  const enc = cryptChannel(c, (v) => encryptSecret(v));
  await db.insert(alertChannels).values({ id: c.id, orgId, data: enc as unknown as Record<string, unknown> });
}
export async function toggleChannel(orgId: string, id: string): Promise<void> {
  await ensureSchema();
  const rows = await db.select({ data: alertChannels.data }).from(alertChannels).where(and(eq(alertChannels.id, id), eq(alertChannels.orgId, orgId))).limit(1);
  if (!rows.length) return;
  const c = rows[0].data as unknown as Channel; // secrets stay encrypted; only flip enabled
  c.enabled = !c.enabled;
  await db.update(alertChannels).set({ data: c as unknown as Record<string, unknown>, updatedAt: new Date() }).where(and(eq(alertChannels.id, id), eq(alertChannels.orgId, orgId)));
}
export async function deleteChannel(orgId: string, id: string): Promise<void> {
  await ensureSchema();
  await db.delete(alertChannels).where(and(eq(alertChannels.id, id), eq(alertChannels.orgId, orgId)));
}
export async function getChannel(orgId: string, id: string): Promise<Channel | null> {
  await ensureSchema();
  const rows = await db.select({ data: alertChannels.data }).from(alertChannels).where(and(eq(alertChannels.id, id), eq(alertChannels.orgId, orgId))).limit(1);
  if (!rows.length) return null;
  return cryptChannel(rows[0].data as unknown as Channel, (v) => decryptSecret(v));
}

/** Redacted view for the client (no secret values leak to the browser). */
export function redact(c: Channel): Channel {
  const fields = CHANNEL_TYPES[c.type].fields;
  const cfg: Record<string, string> = {};
  for (const f of fields) {
    const v = c.config[f.key] || "";
    cfg[f.key] = f.secret && v ? "••••••" : v;
  }
  return { ...c, config: cfg };
}

export type Msg = { title: string; body: string; severity: "critical" | "warning" | "ok" };

export async function send(channel: Channel, msg: Msg): Promise<{ ok: boolean; error?: string }> {
  try {
    const c = channel.config;
    switch (channel.type) {
      case "webhook": {
        await assertSafeUrl(c.url);
        const r = await fetch(c.url, {
          method: "POST",
          redirect: "manual", // don't follow a 30x to an internal target (SSRF)
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ...msg, source: "backwork.dev", ts: new Date().toISOString() }),
        });
        return r.ok ? { ok: true } : { ok: false, error: `HTTP ${r.status}` };
      }
      case "slack": {
        await assertSafeUrl(c.webhookUrl, ["slack.com"]);
        const r = await fetch(c.webhookUrl, {
          method: "POST",
          redirect: "manual", // don't follow a 30x to an internal target (SSRF)
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text: `*${msg.title}*\n${msg.body}` }),
        });
        return r.ok ? { ok: true } : { ok: false, error: `HTTP ${r.status}` };
      }
      case "discord": {
        await assertSafeUrl(c.webhookUrl, ["discord.com", "discordapp.com"]);
        const r = await fetch(c.webhookUrl, {
          method: "POST",
          redirect: "manual", // don't follow a 30x to an internal target (SSRF)
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ content: `**${msg.title}**\n${msg.body}` }),
        });
        return r.ok ? { ok: true } : { ok: false, error: `HTTP ${r.status}` };
      }
      case "email": {
        const nodemailer = ((await import("nodemailer")) as any).default;
        const port = Number(c.port || 587);
        const transport = nodemailer.createTransport({
          host: c.host,
          port,
          secure: port === 465,
          auth: c.user ? { user: c.user, pass: c.pass } : undefined,
        });
        await transport.sendMail({ from: c.from, to: c.to, subject: msg.title, text: msg.body });
        return { ok: true };
      }
      case "sms": {
        const body = new URLSearchParams({ To: c.to, From: c.from, Body: `${msg.title}: ${msg.body}` });
        const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${c.sid}/Messages.json`, {
          method: "POST",
          headers: {
            Authorization: "Basic " + Buffer.from(`${c.sid}:${c.token}`).toString("base64"),
            "content-type": "application/x-www-form-urlencoded",
          },
          body,
        });
        return r.ok ? { ok: true } : { ok: false, error: `HTTP ${r.status} ${(await r.text()).slice(0, 120)}` };
      }
      default:
        return { ok: false, error: "unknown channel type" };
    }
  } catch (e: any) {
    return { ok: false, error: e?.message ? String(e.message) : String(e) };
  }
}
