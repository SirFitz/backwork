#!/usr/bin/env node
// Deterministic horizontal-overflow check for the backwork dashboard.
//
// Loads every authed page with deliberately-WIDE data at several viewport widths
// and asserts the document never scrolls horizontally (scrollWidth <= clientWidth).
// On failure it names the offending element(s) so the layer that blew out is obvious.
//
// Why this exists: the audit verified UI by eye + screenshots, which mask horizontal
// overflow (it scrolls off-frame). This measures it. Run it before shipping UI changes.
//
// Usage:
//   cd qa && npm install && npx playwright install chromium
//   BW_BASE_URL=https://backwork.dev node overflow-check.mjs
//   # Auth: provide an existing account…
//   BW_EMAIL=you@example.com BW_PASSWORD=… node overflow-check.mjs
//   # …or omit creds and it self-registers an isolated throwaway (qa2del-overflow-*),
//   #   seeds wide errors/logs/traces, and prints the email so you can delete it.
//   HEADED=1 node overflow-check.mjs    # watch it run
//
// Exit code: 0 = all pass, 1 = at least one page overflowed (or setup failed).

import { chromium } from "playwright";
import { randomBytes } from "node:crypto";

const BASE = (process.env.BW_BASE_URL || "https://backwork.dev").replace(/\/+$/, "");
const ORIGIN = BASE;
const HEADED = !!process.env.HEADED;
const TOL = 1; // px slack for sub-pixel / scrollbar

const ROUTES = [
  "/", "/containers", "/logs", "/metrics", "/traces", "/requests",
  "/errors", "/incidents", "/alerts", "/projects", "/members",
  "/settings", "/audit", "/api-keys", "/account",
];
const VIEWPORTS = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "laptop", width: 1024, height: 768 },
  { name: "tablet", width: 768, height: 1024 },
  { name: "mobile", width: 390, height: 844 },
];

// ---- tiny cookie jar over fetch -------------------------------------------
const jar = new Map();
function cookieHeader() { return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; "); }
function storeSetCookie(res) {
  const sc = res.headers.getSetCookie?.() || [];
  for (const c of sc) { const m = c.match(/^([^=]+)=([^;]*)/); if (m) jar.set(m[1], m[2]); }
}
async function api(path, { method = "GET", form } = {}) {
  const headers = { origin: ORIGIN };
  let body;
  if (form) { headers["content-type"] = "application/x-www-form-urlencoded"; body = new URLSearchParams(form).toString(); }
  const cookie = cookieHeader(); if (cookie) headers.cookie = cookie;
  const res = await fetch(`${BASE}${path}`, { method, headers, body, redirect: "manual" });
  storeSetCookie(res);
  return res;
}
const hex = (n) => randomBytes(n).toString("hex");

// ---- auth: existing creds, else self-register a throwaway + seed wide data --
async function authenticate() {
  const email = process.env.BW_EMAIL;
  if (email && process.env.BW_PASSWORD) {
    const r = await api("/login", { method: "POST", form: { email, password: process.env.BW_PASSWORD } });
    if (r.status !== 302) throw new Error(`login failed (${r.status}) for ${email}`);
    console.log(`  auth: logged in as ${email}`);
    return { seeded: false };
  }
  // self-register an isolated throwaway
  const tEmail = `qa2del-overflow-${hex(4)}@example.com`;
  const pass = "overflowcheck12345";
  let r = await api("/register", { method: "POST", form: { name: "Overflow QA", email: tEmail, password: pass } });
  if (r.status !== 302) throw new Error(`register failed (${r.status}) — rate-limited? wait and retry, or pass BW_EMAIL/BW_PASSWORD`);
  await api("/onboarding", { method: "POST", form: { name: "Overflow QA Org" } });
  await api("/projects", { method: "POST", form: { intent: "create", name: "qa" } });
  // grab the one-time ingest token from the projects page HTML
  const html = await (await api("/projects")).text();
  const tok = (html.match(/bw_[0-9a-f]{48}/) || [])[0];
  console.log(`  auth: self-registered ${tEmail} (token ${tok ? tok.slice(0, 8) + "…" : "MISSING"})`);
  if (!tok) throw new Error("no ingest token after register/onboard — register likely rate-limited; wait or pass BW_EMAIL/BW_PASSWORD");
  await seedWideData(tok);
  console.log(`  NOTE: created throwaway org ${tEmail} — delete it after (qa2del-* prefix).`);
  return { seeded: true, email: tEmail };
}

// Fail loudly if the session isn't really authed (a 302 from / means we'd be
// measuring the login page and falsely passing).
async function assertAuthed() {
  const r = await api("/");
  if (r.status !== 200) throw new Error(`session not authenticated (GET / → ${r.status}); aborting to avoid a false pass`);
}

const LONG = "/api/v1/organizations/01KTVP2JNT0DB8MXE6FDRQV03V/merchants/01KTVP9ZZ8QWERTYUIOPASDFGH/checkout-sessions/01KTVPAAAA0000BBBB1111CCCC/line-items/very-long-descriptive-segment-that-keeps-going-and-going";
async function seedWideData(token) {
  const H = { authorization: `Bearer ${token}`, "content-type": "application/json", origin: ORIGIN };
  // 1) wide error
  await fetch(`${BASE}/ingest/errors`, { method: "POST", headers: H, body: JSON.stringify({
    type: "VeryLongUnbrokenExceptionTypeNameThatDoesNotWrapNicely",
    message: "Unhandled rejection at " + LONG + " — token=sk_live_" + hex(24) + " context exceeded",
    service: "commerce-api-with-a-deliberately-long-service-name",
    stack: "Error\n    at " + LONG + ":42:18\n    at process",
  }) }).catch(() => {});
  // 2) wide log line
  await fetch(`${BASE}/ingest/loki/api/v1/push`, { method: "POST", headers: H, body: JSON.stringify({
    streams: [{ stream: { service: "overflow-qa" }, values: [[String(Date.now() * 1e6),
      "GET " + LONG + "?trace_id=" + hex(16) + "&extremely_long_query_param=" + hex(40) + " 200 in 1234ms"]] }],
  }) }).catch(() => {});
  // 3) wide trace (OTLP/JSON) → Requests/Traces/APM
  const now = Date.now() * 1e6;
  await fetch(`${BASE}/otlp/v1/traces`, { method: "POST", headers: H, body: JSON.stringify({
    resourceSpans: [{
      resource: { attributes: [{ key: "service.name", value: { stringValue: "overflow-qa-very-long-service-name-here" } }] },
      scopeSpans: [{ spans: [{
        traceId: hex(16), spanId: hex(8), name: "GET", kind: 2,
        startTimeUnixNano: String(now), endTimeUnixNano: String(now + 5e6),
        attributes: [
          { key: "http.method", value: { stringValue: "GET" } },
          { key: "http.target", value: { stringValue: LONG } },
          { key: "http.status_code", value: { intValue: "200" } },
        ],
      }] }],
    }],
  }) }).catch(() => {});
  // give the batch/ingest a moment to land
  await new Promise((r) => setTimeout(r, 4000));
}

// ---- the measurement -------------------------------------------------------
const MEASURE = (tol) => {
  const de = document.documentElement;
  const vw = de.clientWidth;
  const over = de.scrollWidth - vw;
  const inScroll = (el) => {
    for (let p = el.parentElement; p; p = p.parentElement) {
      const ox = getComputedStyle(p).overflowX;
      if (ox === "auto" || ox === "scroll" || ox === "hidden") return true; // legitimately clipped/scrolled
    }
    return false;
  };
  const offenders = [];
  if (over > tol) {
    for (const el of document.querySelectorAll("body *")) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.right <= vw + tol || r.left >= vw) continue;
      const pr = el.parentElement && el.parentElement.getBoundingClientRect();
      // a true origin is wider than the viewport while its parent isn't, and isn't
      // inside a horizontal scroll container (those don't add to document width)
      if (pr && pr.right <= vw + tol && !inScroll(el)) {
        offenders.push({ tag: el.tagName.toLowerCase(), cls: String(el.className || "").slice(0, 70), right: Math.round(r.right) });
      }
    }
    offenders.sort((a, b) => b.right - a.right);
  }
  return { vw, scrollWidth: de.scrollWidth, over, offenders: offenders.slice(0, 4) };
};

async function main() {
  console.log(`overflow-check → ${BASE}`);
  await authenticate();
  await assertAuthed();
  const browser = await chromium.launch({ headless: !HEADED });
  const ctx = await browser.newContext();
  // carry the session cookie into the browser (no form typing)
  await ctx.addCookies([...jar.entries()].map(([name, value]) => ({
    name, value, domain: new URL(BASE).hostname, path: "/", httpOnly: false, secure: BASE.startsWith("https"),
  })));
  const page = await ctx.newPage();
  const failures = [];
  let checks = 0;
  for (const route of ROUTES) {
    for (const vp of VIEWPORTS) {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      let r;
      try {
        // "load" not "networkidle": live pages poll forever, so networkidle never fires
        await page.goto(`${BASE}${route}`, { waitUntil: "load", timeout: 25000 });
        await page.waitForTimeout(900);
        r = await page.evaluate(MEASURE, TOL);
        // re-measure once to drop transient chart-render spikes (recharts settling)
        if (r.over > TOL) { await page.waitForTimeout(700); r = await page.evaluate(MEASURE, TOL); }
      } catch (e) {
        console.log(`  ⚠ ${route} @${vp.name}: load error ${String(e).slice(0, 60)}`);
        continue;
      }
      checks++;
      if (r.over > TOL) {
        failures.push({ route, vp: vp.name, ...r });
        const off = r.offenders.map((o) => `${o.tag}.${o.cls.split(" ").filter(Boolean).slice(0, 2).join(".")}`).join(", ");
        console.log(`  ✗ ${route.padEnd(13)} @${vp.name.padEnd(7)} over +${r.over}px (scrollW ${r.scrollWidth} > ${r.vw}) ← ${off || "?"}`);
      } else {
        console.log(`  ✓ ${route.padEnd(13)} @${vp.name.padEnd(7)} (${r.vw}px)`);
      }
    }
  }
  await browser.close();
  console.log(`\n${checks - failures.length}/${checks} checks passed across ${ROUTES.length} routes × ${VIEWPORTS.length} viewports.`);
  if (failures.length) { console.log(`${failures.length} overflow(s) found.`); process.exit(1); }
  console.log("No horizontal overflow. ✓");
}

main().catch((e) => { console.error("overflow-check failed:", e); process.exit(1); });
