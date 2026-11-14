// Weekly digest content (BAC-77). Pure: no database, Loki, Remix or `.server` imports. Takes what
// the sources returned and writes one plain-text message: short lines, `-` bullets, units always
// shown, no em dashes, no emoji. Sections are omitted when empty; a section whose source failed
// is named in a final "Not available this week" line, never silently missing.

import type { FixItem } from "~/lib/insights/fix-first";
import { CompareVerdict, compareChip, type CompareRow } from "~/lib/hops/compare";
import { markerLabel, type Deploy } from "~/lib/deploys";
import { fmtUs, plural } from "~/lib/hops/time-format";

/** The sections, in the order they appear. */
export const DigestSection = {
  FixFirst: "fix_first",
  Slower: "slower",
  Repeats: "repeats",
  Errors: "errors",
  Alerts: "alerts",
  Deploys: "deploys",
  Usage: "usage",
} as const;
export type DigestSection = (typeof DigestSection)[keyof typeof DigestSection];
export const DIGEST_SECTIONS: readonly DigestSection[] = Object.values(DigestSection);

export const DIGEST_SECTION_TITLE: Record<DigestSection, string> = {
  [DigestSection.FixFirst]: "Fix first",
  [DigestSection.Slower]: "Slower than last week",
  [DigestSection.Repeats]: "Repeated calls",
  [DigestSection.Errors]: "Errors",
  [DigestSection.Alerts]: "Alerts this week",
  [DigestSection.Deploys]: "Deploys",
  [DigestSection.Usage]: "Usage",
};

/** Items per section at most. */
export const DIGEST_FIX_ITEMS = 5;
export const DIGEST_SLOWER_ITEMS = 5;
export const DIGEST_REPEAT_ITEMS = 3;
export const DIGEST_ERROR_ITEMS = 5;
/** Alerts listed under the count line. */
export const DIGEST_ALERT_ITEMS = 3;
/** Deploys listed under the count line. */
export const DIGEST_DEPLOY_ITEMS = 3;
/** No line of the body is longer than this, characters (longer names are cut with "..."). */
export const DIGEST_LINE_MAX_CHARS = 110;

/** One repeated query (from the repeats scan's `RepeatRow`). */
export interface DigestRepeat {
  /** "select plans". */
  label: string;
  service: string;
  /** Requests in which it repeated. */
  requests: number;
  medianRepeats: number;
  /** What fetching the calls together could have saved, microseconds. */
  wastedUs: number;
}

/** One open error group seen this week. */
export interface DigestErrorGroup {
  type: string;
  message: string;
  service: string;
  /** First seen this week. */
  isNew: boolean;
  /** Occurrences this week. */
  weekCount: number;
}

export interface DigestAlertEvent {
  rule: string;
  /** epoch ms */
  firedAt: number;
  /** epoch ms, null while still firing */
  resolvedAt: number | null;
}

export interface DigestUsage {
  /** This calendar month so far (UTC). */
  requests: number;
  /** What the plan includes each month, null when it is not billed by use. */
  includedRequests: number | null;
  bytes: number;
  includedBytes: number | null;
}

export interface DigestInput {
  orgName: string;
  /** When the digest is built (epoch ms). */
  now: number;
  /** Start of the week it covers (epoch ms). */
  weekStart: number;
  /** Where "Open Insights" points (absolute URL). */
  insightsUrl: string;
  /** Where the settings are (absolute URL), for the email footer. */
  settingsUrl: string;
  /** Fix first over its longest window, ranked. */
  fixFirst: FixItem[];
  /** The phrase of that window: "last 6 hours". */
  fixWindowPhrase: string;
  /** Services against the same 24 hours last week (any verdict; only slower or failing more are listed). */
  regressions: CompareRow[];
  /** Most wasted time first. */
  newRepeats: DigestRepeat[];
  /** The repeats scan hit its record cap: counts are a sample. */
  repeatsSampled: boolean;
  /** The phrase of the repeats window: "last 6 hours". */
  repeatsWindowPhrase: string;
  errorGroups: DigestErrorGroup[];
  alertEvents: DigestAlertEvent[];
  /** This week, any order. */
  deploys: Deploy[];
  usage: DigestUsage | null;
  /** Names of the sources that failed to load ("slow queries"). */
  unavailable: string[];
}

/** One section as the webhook receives it. */
export interface DigestSectionView {
  key: DigestSection;
  title: string;
  lines: string[];
}

export interface Digest {
  title: string;
  /** Slack, Discord and webhook text: sections and bullets, no title (the channel adds it). */
  body: string;
  /** Email: the body with the link and a footer naming where to change the settings. */
  emailText: string;
  /** Absolute link to /insights; Slack, Discord and email show it under the body. */
  link: string;
  /** Nothing to report, every source answered. */
  quiet: boolean;
  sections: DigestSectionView[];
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "10 Nov" (UTC). */
export function dayText(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

/** "10 Nov 08:00 UTC". */
export function whenText(ms: number): string {
  const d = new Date(ms);
  return `${dayText(ms)} ${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")} UTC`;
}

/** Cut text to `max` characters, ending in "..." when cut. */
export function clip(text: string, max: number): string {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length <= max ? one : `${one.slice(0, Math.max(0, max - 3)).trimEnd()}...`;
}

/** Keep a whole line within the limit by cutting its name part. */
function line(name: string, rest: string, prefix: string = "- "): string {
  const room = DIGEST_LINE_MAX_CHARS - prefix.length - rest.length;
  return `${prefix}${clip(name, Math.max(12, room))}${rest}`;
}

function count(n: number): string {
  return Math.round(n).toLocaleString("en-GB");
}

const KB = 1024;
/** Bytes in binary units named as the plans name them (1 GB = 1024^3 bytes): "512 B", "3.4 MB", "20 GB". */
export function fmtBytes(bytes: number): string {
  if (bytes < KB) return `${Math.max(0, Math.round(bytes))} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = bytes / KB;
  let i = 0;
  while (v >= KB && i < units.length - 1) {
    v /= KB;
    i++;
  }
  return `${v >= 100 || Number.isInteger(v) ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

/** "42 min", "3 h 5 min", "2 days". */
export function spanText(ms: number): string {
  const min = Math.max(1, Math.round(ms / 60_000));
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  if (h < 48) return min % 60 ? `${h} h ${min % 60} min` : `${h} h`;
  return `${Math.round(h / 24)} days`;
}

function ms(seconds: number): string {
  return fmtUs(seconds * 1_000_000);
}

function fixLines(items: readonly FixItem[]): string[] {
  return items.slice(0, DIGEST_FIX_ITEMS).map((it, i) => {
    // A regression's title already names its service ("shop-api, slower than last week").
    const svc = it.title.startsWith(it.service) ? "" : ` (${it.service})`;
    return line(it.title, `${svc}: ${it.impactLabel}`, `${i + 1}. `);
  });
}

function slowerLines(rows: readonly CompareRow[]): string[] {
  return rows
    .filter((r) => r.verdict === CompareVerdict.Slower || r.verdict === CompareVerdict.MoreErrors)
    .sort((a, b) => (b.p95Ratio ?? 0) - (a.p95Ratio ?? 0) || a.service.localeCompare(b.service))
    .slice(0, DIGEST_SLOWER_ITEMS)
    .map((r) => {
      const chip = compareChip(r).text;
      const detail =
        r.verdict === CompareVerdict.Slower && r.now.p95 !== null && r.before?.p95 != null
          ? `p95 ${ms(r.now.p95)}, was ${ms(r.before.p95)}`
          : `${Math.round(r.now.errorShare * 100)}% failed, was ${Math.round((r.before?.errorShare ?? 0) * 100)}%`;
      const name = r.method && r.op ? `${r.service} ${r.method} ${r.op}` : r.service;
      return line(name, `: ${chip}, ${detail}`);
    });
}

function repeatLines(rows: readonly DigestRepeat[]): string[] {
  const out = rows.slice(0, DIGEST_REPEAT_ITEMS).map((r) =>
    line(r.label, ` in ${r.service}: ${Math.round(r.medianRepeats)} times per request in ${plural(r.requests, "request", "requests")}, could save ${fmtUs(r.wastedUs)}`),
  );
  return out;
}

function errorLines(groups: readonly DigestErrorGroup[]): string[] {
  return [...groups]
    .sort((a, b) => Number(b.isNew) - Number(a.isNew) || b.weekCount - a.weekCount || a.type.localeCompare(b.type))
    .slice(0, DIGEST_ERROR_ITEMS)
    .map((g) => {
      const name = g.message ? `${g.type}: ${g.message}` : g.type;
      const svc = g.service ? ` (${g.service})` : "";
      const tail = `${g.isNew ? "new, " : ""}${plural(g.weekCount, "time", "times")} this week`;
      return line(name, `${svc}: ${tail}`);
    });
}

function alertLines(events: readonly DigestAlertEvent[], now: number): string[] {
  if (!events.length) return [];
  const span = (e: DigestAlertEvent): number => (e.resolvedAt ?? now) - e.firedAt;
  const longest = [...events].sort((a, b) => span(b) - span(a))[0];
  const still = events.filter((e) => e.resolvedAt === null).length;
  const head = `${plural(events.length, "alert", "alerts")} fired${still ? `, ${still} still firing` : ""}. Longest: ${clip(longest.rule, 40)}, ${spanText(span(longest))}${longest.resolvedAt === null ? " so far" : ""}.`;
  const items = [...events]
    .sort((a, b) => b.firedAt - a.firedAt)
    .slice(0, DIGEST_ALERT_ITEMS)
    .map((e) => line(e.rule, `: fired ${whenText(e.firedAt)}, ${e.resolvedAt === null ? "still firing" : `resolved after ${spanText(span(e))}`}`));
  return [head, ...items];
}

function deployLines(deploys: readonly Deploy[]): string[] {
  if (!deploys.length) return [];
  const sorted = [...deploys].sort((a, b) => b.deployedAt - a.deployedAt);
  const services = new Set(sorted.map((d) => d.service)).size;
  const head = `${plural(sorted.length, "deploy", "deploys")} to ${plural(services, "service", "services")}.${sorted.length > DIGEST_DEPLOY_ITEMS ? " Latest:" : ""}`;
  return [head, ...sorted.slice(0, DIGEST_DEPLOY_ITEMS).map((d) => line(`${d.service} ${markerLabel(d)}`, `, ${whenText(d.deployedAt)}`))];
}

function usageLine(u: DigestUsage | null): string[] {
  if (!u) return [];
  const req = u.includedRequests !== null ? `${count(u.requests)} of ${count(u.includedRequests)} requests` : `${count(u.requests)} requests`;
  const bytes = u.includedBytes !== null ? `${fmtBytes(u.bytes)} of ${fmtBytes(u.includedBytes)}` : fmtBytes(u.bytes);
  return [`This month so far: ${req}, ${bytes} of data${u.includedRequests !== null ? " included in the plan" : ""}.`];
}

/** The digest for one organisation and week. */
export function buildDigest(i: DigestInput): Digest {
  const content: Array<[DigestSection, string[]]> = [
    [DigestSection.FixFirst, fixLines(i.fixFirst)],
    [DigestSection.Slower, slowerLines(i.regressions)],
    [DigestSection.Repeats, repeatLines(i.newRepeats)],
    [DigestSection.Errors, errorLines(i.errorGroups)],
    [DigestSection.Alerts, alertLines(i.alertEvents, i.now)],
    [DigestSection.Deploys, deployLines(i.deploys)],
  ];
  const window: Partial<Record<DigestSection, string>> = {
    [DigestSection.FixFirst]: i.fixWindowPhrase,
    [DigestSection.Repeats]: i.repeatsSampled ? `${i.repeatsWindowPhrase}, sampled, so at least these counts` : i.repeatsWindowPhrase,
  };
  const sections: DigestSectionView[] = content
    .filter(([, lines]) => lines.length > 0)
    .map(([key, lines]) => ({ key, title: window[key] ? `${DIGEST_SECTION_TITLE[key]} (${window[key]})` : DIGEST_SECTION_TITLE[key], lines }));
  const findings = sections.length > 0;
  const usage = usageLine(i.usage);
  if (usage.length) sections.push({ key: DigestSection.Usage, title: DIGEST_SECTION_TITLE[DigestSection.Usage], lines: usage });
  const quiet = !findings && i.unavailable.length === 0;

  const blocks: string[] = [];
  if (!findings) {
    blocks.push(
      i.unavailable.length === 0
        ? "All quiet this week: nothing to fix first, nothing slower than last week, no new errors, no alerts fired and no deploys."
        : "Nothing to report from the sources that answered.",
    );
  }
  for (const s of sections) blocks.push(`${s.title}\n${s.lines.join("\n")}`);
  if (i.unavailable.length) blocks.push(`Not available this week: ${i.unavailable.join(", ")}.`);
  const body = blocks.join("\n\n");

  const title = `backwork weekly: ${clip(i.orgName, 60)}, week of ${dayText(i.weekStart)}`;
  const emailText = [
    title,
    "",
    body,
    "",
    `Open Insights: ${i.insightsUrl}`,
    "",
    `Sent weekly by backwork. Change the day, the time or who gets it on the Alerts page: ${i.settingsUrl}`,
  ].join("\n");
  return { title, body, emailText, link: i.insightsUrl, quiet, sections };
}
