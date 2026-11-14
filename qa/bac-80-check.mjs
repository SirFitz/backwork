// BAC-80 browser check (tests only): Requests shows the domain, the box finds a domain, monitors
// are hidden by default and shown with the toggle, a monitor's request view shows the Monitor chip,
// an old record's view renders without a domain line, nothing scrolls sideways. Own Chrome
// (Playwright launches it over a pipe; no shared debugging port).
//   BW_BASE_URL=http://127.0.0.1:3580 BW_COOKIE=<backwork_auth value> MONITOR_TRACE=<id> OLD_TRACE=<id> \
//     OUT=<dir> node qa/bac-80-check.mjs
import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const BASE = process.env.BW_BASE_URL ?? "http://127.0.0.1:3580";
const OUT = process.env.OUT ?? "bac-80-shots";
const MONITOR_TRACE = process.env.MONITOR_TRACE ?? "";
const OLD_TRACE = process.env.OLD_TRACE ?? "";
const MONITOR_HOST = "binary.fleeksite.com";
const SHOPPER_HOST = "shop.example.com";
mkdirSync(OUT, { recursive: true });

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`);
};

const browser = await chromium.launch({ channel: "chrome", headless: true });
const url = new URL(BASE);

async function pageAt(width, height) {
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 2 });
  await ctx.addCookies([{ name: "backwork_auth", value: process.env.BW_COOKIE ?? "", domain: url.hostname, path: "/", httpOnly: true }]);
  return { ctx, page: await ctx.newPage() };
}

const sideways = (page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
/** Visible rows of the list in this layout: phone cards or desktop table rows. */
const rowsSel = (phone) => (phone ? "ul.md\\:hidden > li" : "div.md\\:block table tbody tr");
const visibleText = (page, phone) => page.locator(rowsSel(phone)).allInnerTexts();

async function waitRows(page, phone) {
  await page.locator(rowsSel(phone)).or(page.getByText("No matching requests")).first().waitFor({ timeout: 30_000 });
}

for (const [label, w, h] of [["1440", 1440, 900], ["390", 390, 844]]) {
  const phone = w < 768;
  const { ctx, page } = await pageAt(w, h);

  // Default: monitors hidden.
  await page.goto(`${BASE}/requests`, { waitUntil: "networkidle" });
  await waitRows(page, phone);
  let texts = await visibleText(page, phone);
  check(`${label} default: rows load`, texts.length > 0, `${texts.length} rows`);
  check(`${label} default: no monitor rows`, !texts.some((t) => t.includes(MONITOR_HOST)) && !texts.some((t) => /\bMonitor\b/.test(t)));
  check(`${label} default: shopper domain shown`, texts.some((t) => t.includes(SHOPPER_HOST)));
  if (!phone) check(`${label} Domain column header`, (await page.locator("thead th", { hasText: "Domain" }).count()) === 1);
  check(`${label} old rows show no placeholder for the domain`, !texts.some((t) => /\n—\n/.test(t) && t.includes("commerce-worker")));
  check(`${label} default: no sideways scroll`, (await sideways(page)) <= 0, `overflow ${await sideways(page)}px`);
  const headerBottom = await page.evaluate(() => document.querySelector("header")?.getBoundingClientRect().bottom ?? 0);
  const firstCard = await page.evaluate(() => {
    const el = document.querySelector("main .grid > *, main [class*='rounded-xl']");
    return el ? el.getBoundingClientRect().top : null;
  });
  console.log(`INFO ${label} header bottom to first card: ${firstCard === null ? "n/a" : Math.round(firstCard - headerBottom)}px`);
  await page.screenshot({ path: join(OUT, `requests-default-${label}.png`), fullPage: false });

  // The box filters by domain (shopper visible by default).
  const box = page.locator(`input[aria-label="Filter by path, route, domain or service"]:visible`);
  await box.fill(SHOPPER_HOST);
  texts = await visibleText(page, phone);
  check(`${label} box finds ${SHOPPER_HOST}`, texts.length > 0 && texts.every((t) => t.includes(SHOPPER_HOST)), `${texts.length} rows`);

  // Toggle on (desktop: the checkbox in the row; phone: under "More filters").
  if (phone) await page.locator("details summary", { hasText: "More filters" }).click();
  await Promise.all([
    page.waitForURL(/health=1/, { timeout: 30_000 }),
    page.locator("label:visible", { hasText: "Show health checks and monitors" }).locator("input").check(),
  ]);
  await page.waitForLoadState("networkidle");
  // The feed remounts for the new toggle state: wait until a monitor row is listed, then filter.
  await page.locator(rowsSel(phone), { hasText: MONITOR_HOST }).first().waitFor({ timeout: 30_000 });
  await box.fill(MONITOR_HOST);
  for (let i = 0; i < 20; i++) {
    texts = await visibleText(page, phone);
    if (texts.length > 0 && texts.every((t) => t.includes(MONITOR_HOST))) break;
    await page.waitForTimeout(250);
  }
  check(`${label} toggle on: box finds ${MONITOR_HOST}`, texts.length > 0 && texts.every((t) => t.includes(MONITOR_HOST)), `${texts.length} rows`);
  check(`${label} toggle on: monitor rows carry the Monitor badge`, texts.length > 0 && texts.every((t) => t.includes("Monitor")));
  check(`${label} toggle on: no sideways scroll`, (await sideways(page)) <= 0, `overflow ${await sideways(page)}px`);
  await page.screenshot({ path: join(OUT, `requests-monitors-${label}.png`), fullPage: false });
  await box.fill("");

  // A monitor's request view.
  if (MONITOR_TRACE) {
    await page.goto(`${BASE}/requests/${MONITOR_TRACE}`, { waitUntil: "networkidle" });
    await page.locator("h1:visible").first().waitFor({ timeout: 30_000 });
    const h1 = (await page.locator("h1:visible").first().innerText()).replace(/\s+/g, " ");
    check(`${label} monitor view: Monitor chip`, /\bMonitor\b/.test(h1), h1);
    const head = await page.locator("[data-content]").first().innerText();
    check(`${label} monitor view: domain next to the route`, head.includes(MONITOR_HOST));
    check(`${label} monitor view: no sideways scroll`, (await sideways(page)) <= 0, `overflow ${await sideways(page)}px`);
    await page.screenshot({ path: join(OUT, `request-view-monitor-${label}.png`), fullPage: false });
  }
  // An old record's request view: renders, no domain line, no chip.
  if (OLD_TRACE) {
    await page.goto(`${BASE}/requests/${OLD_TRACE}`, { waitUntil: "networkidle" });
    await page.locator("h1:visible").first().waitFor({ timeout: 30_000 });
    const head = await page.locator("[data-content]").first().innerText();
    check(`${label} old view: renders without chip or domain`, !/\bMonitor\b/.test(head) && !head.includes(".example.com") && !head.includes("fleeksite"), head.split("\n")[0]);
    check(`${label} old view: no sideways scroll`, (await sideways(page)) <= 0);
    await page.screenshot({ path: join(OUT, `request-view-old-${label}.png`), fullPage: false });
  }
  await ctx.close();
}

await browser.close();
writeFileSync(join(OUT, "results.json"), JSON.stringify(results, null, 2));
const failed = results.filter((r) => !r.ok).length;
console.log(`${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
