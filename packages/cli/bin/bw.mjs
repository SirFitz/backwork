#!/usr/bin/env node
// backwork CLI — query the backwork.dev observability read API from your terminal.
// Zero dependencies; needs Node >= 18 (global fetch). Auth: a bwk_ API key from
// the dashboard (org dropdown → API keys), via BACKWORK_API_KEY or --key.

const VERSION = "0.1.0";
const argv = process.argv.slice(2);

// ---- tiny arg parser -------------------------------------------------------
const opts = {};
const positional = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith("--")) {
    const eq = a.indexOf("=");
    if (eq !== -1) opts[a.slice(2, eq)] = a.slice(eq + 1);
    else if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) opts[a.slice(2)] = argv[++i];
    else opts[a.slice(2)] = true;
  } else positional.push(a);
}

const cmd = positional[0];
const useColor = process.stdout.isTTY && !opts["no-color"];
const c = (code, s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const dim = (s) => c("2", s), bold = (s) => c("1", s), red = (s) => c("31", s),
  green = (s) => c("32", s), yellow = (s) => c("33", s), cyan = (s) => c("36", s);

const baseUrl = String(opts.url || process.env.BACKWORK_API_URL || "https://backwork.dev").replace(/\/+$/, "");
const apiKey = String(opts.key || process.env.BACKWORK_API_KEY || "");
const asJson = !!opts.json;

function die(msg, code = 1) { process.stderr.write(red("error: ") + msg + "\n"); process.exit(code); }

const HELP = `${bold("bw")} — backwork.dev observability CLI  ${dim("v" + VERSION)}

${bold("USAGE")}
  bw <command> [options]

${bold("COMMANDS")}
  me                     Verify your API key and show its organization
  errors                 List error groups
  incidents              List current incidents
  services               Per-service health
  help | version

${bold("OPTIONS")}
  --status <s>           errors: open|resolved|ignored|all   (default: open)
  --service <name>       errors: filter to one service
  --limit <n>            errors: max groups                   (default: 100)
  --json                 Raw JSON output (for piping to jq)
  --key <bwk_…>          API key (or set BACKWORK_API_KEY)
  --url <url>            API base URL (or BACKWORK_API_URL; default backwork.dev)
  --no-color

${bold("EXAMPLES")}
  export BACKWORK_API_KEY=bwk_…
  bw me
  bw errors --status open --limit 20
  bw errors --json | jq '.errors[].type'
  bw incidents

Create a key in the dashboard: org dropdown → ${cyan("API keys")}.`;

async function api(path) {
  if (!apiKey) die("no API key. Set BACKWORK_API_KEY or pass --key (create one at " + baseUrl + "/api-keys).", 2);
  let res;
  try {
    res = await fetch(`${baseUrl}${path}`, { headers: { authorization: `Bearer ${apiKey}` } });
  } catch (e) {
    die(`could not reach ${baseUrl} — ${e?.message || e}`);
  }
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = { raw: text }; }
  if (res.status === 401) die("unauthorized — the API key is missing, invalid, or revoked.", 1);
  if (!res.ok) die(`API ${res.status}: ${body?.error || text.slice(0, 200)}`);
  return body;
}

// ---- table helper ----------------------------------------------------------
function table(headers, rows) {
  if (!rows.length) return dim("  (none)");
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i] ?? "").length)));
  const fmt = (cells, style) => "  " + cells.map((v, i) => style(String(v ?? "").padEnd(widths[i]))).join("  ");
  const out = [fmt(headers, dim)];
  for (const r of rows) out.push("  " + r.map((v, i) => String(v ?? "").padEnd(widths[i])).join("  "));
  return out.join("\n");
}
const trunc = (s, n) => { s = String(s ?? ""); return s.length > n ? s.slice(0, n - 1) + "…" : s; };
function ago(d) {
  const t = typeof d === "number" ? d : Date.parse(d);
  if (!t) return "—";
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return Math.floor(s) + "s";
  if (s < 3600) return Math.floor(s / 60) + "m";
  if (s < 86400) return Math.floor(s / 3600) + "h";
  return Math.floor(s / 86400) + "d";
}
const statusColor = { open: red, resolved: green, ignored: dim, up: green, healthy: green, degraded: yellow, down: red, unhealthy: red, stopped: dim };
const sev = (s) => (s === "critical" ? red(s) : yellow(s));

// ---- commands --------------------------------------------------------------
async function main() {
  if (!cmd || cmd === "help" || opts.help) { console.log(HELP); return; }
  if (cmd === "version" || opts.version) { console.log("bw " + VERSION); return; }

  if (cmd === "me") {
    const r = await api("/api/v1/me");
    if (asJson) return console.log(JSON.stringify(r, null, 2));
    const o = r.org || {};
    console.log(`${green("✓")} key valid — org ${bold(o.name || o.id)} ${dim(o.slug ? "(" + o.slug + ")" : "")}`);
    return;
  }

  if (cmd === "errors") {
    const q = new URLSearchParams();
    q.set("status", String(opts.status || "open"));
    if (opts.service) q.set("service", String(opts.service));
    q.set("limit", String(opts.limit || 100));
    const r = await api(`/api/v1/errors?${q}`);
    if (asJson) return console.log(JSON.stringify(r, null, 2));
    const rows = (r.errors || []).map((e) => [
      (statusColor[e.status] || ((x) => x))(e.status),
      e.count,
      trunc(e.service || "—", 16),
      trunc(e.type, 22),
      trunc(e.message, 48),
      ago(e.lastSeen),
    ]);
    console.log(table(["STATUS", "EVENTS", "SERVICE", "TYPE", "MESSAGE", "LAST"], rows));
    console.log(dim(`\n  ${r.count} error group${r.count === 1 ? "" : "s"} (status=${opts.status || "open"})`));
    return;
  }

  if (cmd === "incidents") {
    const r = await api("/api/v1/incidents");
    if (asJson) return console.log(JSON.stringify(r, null, 2));
    const rows = (r.incidents || []).map((i) => [sev(i.severity), trunc(i.type, 12), trunc(i.service || "—", 18), trunc(i.title, 50), ago(i.ts)]);
    console.log(table(["SEVERITY", "TYPE", "SERVICE", "TITLE", "AGE"], rows));
    console.log(dim(`\n  ${r.count} incident${r.count === 1 ? "" : "s"}`));
    return;
  }

  if (cmd === "services") {
    const r = await api("/api/v1/services");
    if (asJson) return console.log(JSON.stringify(r, null, 2));
    const rows = (r.services || []).map((s) => [
      (statusColor[s.status] || ((x) => x))(s.status),
      trunc(s.service, 24),
      `${s.running}/${s.containers}`,
      (s.errorRate ?? 0).toFixed(2),
      s.restarts ?? 0,
    ]);
    console.log(table(["STATUS", "SERVICE", "RUNNING", "ERR/s", "RESTARTS"], rows));
    console.log(dim(`\n  ${r.count} service${r.count === 1 ? "" : "s"}`));
    return;
  }

  die(`unknown command "${cmd}". Run ${bold("bw help")}.`, 2);
}

main().catch((e) => die(e?.message || String(e)));
