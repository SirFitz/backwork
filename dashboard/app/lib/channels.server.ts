import { promises as fs } from "node:fs";
import path from "node:path";
import { config } from "./config.server";

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

const FILE = () => path.join(config.dataDir, "channels.json");

export async function loadChannels(): Promise<Channel[]> {
  try {
    const parsed = JSON.parse(await fs.readFile(FILE(), "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export async function saveChannels(channels: Channel[]): Promise<void> {
  try {
    await fs.mkdir(config.dataDir, { recursive: true });
    await fs.writeFile(FILE(), JSON.stringify(channels, null, 2), "utf8");
  } catch {
    /* read-only data dir */
  }
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
        const r = await fetch(c.url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ...msg, source: "backwork.dev", ts: new Date().toISOString() }),
        });
        return r.ok ? { ok: true } : { ok: false, error: `HTTP ${r.status}` };
      }
      case "slack": {
        const r = await fetch(c.webhookUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text: `*${msg.title}*\n${msg.body}` }),
        });
        return r.ok ? { ok: true } : { ok: false, error: `HTTP ${r.status}` };
      }
      case "discord": {
        const r = await fetch(c.webhookUrl, {
          method: "POST",
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
