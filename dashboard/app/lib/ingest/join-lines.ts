/**
 * Ingest fallback for multi-line errors (BAC-94). An agent installed before its collector joined
 * multi-line entries still sends an error block as one line per newline, and the header line
 * (level error) and the rest (level info) arrive in different Loki streams. Within one push, this
 * puts an error-level entry back together with the lines that follow it from the same container
 * (same labels apart from level and kind), by the rules in lib/log-join.ts plus a look at the line
 * before, which the collector cannot do.
 *
 * Only an error- or fatal-level entry opens a block, so ordinary lines are never merged. Pure.
 */
import {
  ERROR_HEADER_RE,
  EXCERPT_LINE_RE,
  JOIN_MAX_CHARS,
  JOIN_MAX_LINES,
  JOIN_TIMEOUT_MS,
  LineRole,
  lineRole,
} from "~/lib/log-join";
import type { LokiStream } from "~/lib/ingest/enforce.server";

/** Labels that differ between the lines of one block and so are left out of its origin. */
const SPLIT_LABELS: ReadonlySet<string> = new Set(["level", "kind"]);
const OPENING_LEVELS: ReadonlySet<string> = new Set(["error", "fatal", "critical"]);
const NS_PER_MS = 1_000_000n;

type Fields = Record<string, unknown>;

function isObject(v: unknown): v is Fields {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

interface Entry {
  stream: number;
  value: number;
  ns: bigint;
  /** The raw log line (the envelope's message, or the value itself). */
  text: string;
  envelope: Fields | null;
  level: string;
}

/** One block being put together. */
interface Block {
  head: Entry;
  lines: string[];
  lastNs: bigint;
  chars: number;
  sawName: boolean;
  sawExcerpt: boolean;
  lastBlank: boolean;
}

function origin(labels: Readonly<Record<string, string>>): string {
  return JSON.stringify(Object.entries(labels).filter(([k]) => !SPLIT_LABELS.has(k)).sort(([a], [b]) => a.localeCompare(b)));
}

function entryOf(s: LokiStream, si: number, vi: number): Entry | null {
  const v = s.values[vi];
  if (!Array.isArray(v) || typeof v[0] !== "string" || typeof v[1] !== "string" || !/^\d+$/.test(v[0])) return null;
  const line = v[1];
  let envelope: Fields | null = null;
  if (line.startsWith("{")) {
    try {
      const p: unknown = JSON.parse(line);
      if (isObject(p) && typeof p.message === "string") envelope = p;
    } catch {
      envelope = null;
    }
  }
  const text = envelope ? (envelope.message as string) : line;
  const level = String(s.stream.level ?? envelope?.level ?? "").toLowerCase();
  return { stream: si, value: vi, ns: BigInt(v[0]), text, envelope, level };
}

/** Whether `e` joins `b`: the next line of the same block. */
function joins(b: Block, e: Entry): boolean {
  if (e.ns < b.lastNs || e.ns - b.lastNs > BigInt(JOIN_TIMEOUT_MS) * NS_PER_MS) return false;
  if (b.lines.length >= JOIN_MAX_LINES || b.chars + e.text.length > JOIN_MAX_CHARS) return false;
  if (e.text.includes("\n")) return false;
  const role = lineRole(e.text);
  if (role === LineRole.Continuation) return true;
  // `Name: message` directly after the header line(s).
  if (role === LineRole.Detail) return !b.sawName && b.lines.length === 1 && ERROR_HEADER_RE.test(b.lines[0]);
  // The template's message after its excerpt and a blank line.
  return b.sawExcerpt && b.lastBlank;
}

function add(b: Block, e: Entry): void {
  b.lines.push(e.text);
  b.lastNs = e.ns;
  b.chars += e.text.length + 1;
  if (lineRole(e.text) === LineRole.Detail) b.sawName = true;
  if (EXCERPT_LINE_RE.test(e.text)) b.sawExcerpt = true;
  b.lastBlank = e.text.trim() === "";
}

/**
 * The push with split error blocks joined: the block's lines go into its first line's value
 * (message, and display when it was the same text), and the joined lines are removed.
 * Streams and lines that are not part of a block are returned as they came.
 */
export function joinSplitEntries(streams: readonly LokiStream[]): LokiStream[] {
  const byOrigin = new Map<string, Entry[]>();
  streams.forEach((s, si) => {
    if (!isObject(s) || !isObject(s.stream) || !Array.isArray(s.values) || s.stream.kind === "hop") return;
    const key = origin(s.stream);
    let list = byOrigin.get(key);
    if (!list) byOrigin.set(key, (list = []));
    for (let vi = 0; vi < s.values.length; vi++) {
      const e = entryOf(s, si, vi);
      if (e) list.push(e);
    }
  });

  const joined = new Map<string, string>();
  const removed = new Set<string>();
  const at = (e: Entry): string => `${e.stream}:${e.value}`;
  for (const list of byOrigin.values()) {
    if (list.length < 2) continue;
    list.sort((a, b) => (a.ns < b.ns ? -1 : a.ns > b.ns ? 1 : a.stream - b.stream || a.value - b.value));
    let open: Block | null = null;
    const close = (): void => {
      if (open && open.lines.length > 1) joined.set(at(open.head), open.lines.join("\n").replace(/\s+$/, ""));
      open = null;
    };
    for (const e of list) {
      if (open && joins(open, e)) {
        add(open, e);
        removed.add(at(e));
        continue;
      }
      close();
      if (OPENING_LEVELS.has(e.level) && lineRole(e.text) !== LineRole.Continuation) {
        open = { head: e, lines: [], lastNs: e.ns, chars: 0, sawName: false, sawExcerpt: false, lastBlank: false };
        add(open, e);
      }
    }
    close();
  }
  if (joined.size === 0) return [...streams];

  return streams.map((s, si) => {
    if (!isObject(s) || !Array.isArray(s.values)) return s;
    const values: unknown[][] = [];
    s.values.forEach((v, vi) => {
      const key = `${si}:${vi}`;
      if (removed.has(key)) return;
      const text = joined.get(key);
      if (text === undefined || !Array.isArray(v)) {
        values.push(v);
        return;
      }
      const e = entryOf(s, si, vi)!;
      let line: string;
      if (e.envelope) {
        const env: Fields = { ...e.envelope, message: text };
        if (e.envelope.display === e.envelope.message) env.display = text;
        line = JSON.stringify(env);
      } else line = text;
      values.push([v[0], line, ...v.slice(2)]);
    });
    return { ...s, values };
  });
}
