/**
 * Multi-line log entries (BAC-94). A runtime that prints one entry over several lines (an
 * error header, `Name: message`, a template excerpt, the `at …` stack, `extra: {…}`) reaches
 * Docker as one line per newline. These are the rules that put such an entry back together.
 *
 * One definition, two users:
 *   - the collector (Vector, `vector-config.server.ts`): two reduce stages built from these
 *     patterns, so entries are joined before they become events;
 *   - the ingest proxy (`ingest/join-lines.ts`): a fallback for agents that still send the lines
 *     split, which can also look at the line before (Vector's reduce cannot).
 *
 * Every pattern is in the subset JavaScript and Rust's regex crate read alike (no lookaround,
 * no backreferences). Pure and client-safe.
 */

/** How long a collector waits for the next line of an entry, and the most it joins. */
export const JOIN_TIMEOUT_MS = 1000;
export const JOIN_MAX_LINES = 200;
/** A joined entry is cut here (characters), so one runaway dump cannot make a huge event. */
export const JOIN_MAX_CHARS = 32_768;

/**
 * A line that belongs to the entry before it, whatever that entry is: blank, indented
 * (stack frames, template excerpts, util.inspect dumps), `extra: {…}`, or a closing bracket
 * (the last line of a dump, maybe with the trace id a console patch appends).
 */
export const CONTINUATION_PATTERN = String.raw`^(?:\s*$|[ \t]|extra: |[\]})]+[,;]?(?:\s+trace_id=[0-9a-f]{32})?\s*$)`;

/** Lines that are complete entries on their own and never take continuation lines: JSON
 *  objects and Correlator hop records / link lines. */
export const SOLO_PATTERN = String.raw`^\{|trace_id=[0-9a-f]{32} (?:hop=|link_name=)`;

/** An error header printed on its own line before the error itself: a `[level]` tag line
 *  (`[error] Uncaught in GET /help | company 12`) or a NestJS ERROR/FATAL line. */
export const ERROR_HEADER_PATTERN = String.raw`^(?:\[(?:error|fatal|warn|warning|critical)\]|(?:\x1b\[[0-9;]*m)*\[Nest\][^\n]*\s(?:\x1b\[[0-9;]*m)?(?:ERROR|FATAL)(?:\x1b\[[0-9;]*m)?\s)`;

/** A template excerpt line (ejs): ` >> 1| <%- include(x) %>` or `    2| <script>`. */
export const EXCERPT_LINE_PATTERN = String.raw`^\s*(?:>>\s*)?\d+\|`;

/** `Name: message` (`TypeError: x`, `ApiError: GET /a failed`, `Error [ERR_X]: y`). Group 1 is the
 *  name, group 2 the message. */
export const ERROR_NAME_LINE_PATTERN = String.raw`^((?:[A-Z][A-Za-z0-9_$]*)?(?:Error|Exception))(?:\s*\[[A-Za-z0-9_.-]+\])?:\s?(.*)$`;

/** A stack frame line (`    at fn (file:1:2)`). */
export const STACK_FRAME_PATTERN = String.raw`^\s+at\s`;

/** The trace id a console patch appends to the last line of an entry. */
export const TRAILING_TRACE_PATTERN = String.raw`\s+trace_id=[0-9a-f]{32}\s*$`;

export const CONTINUATION_RE = new RegExp(CONTINUATION_PATTERN);
export const SOLO_RE = new RegExp(SOLO_PATTERN);
export const ERROR_HEADER_RE = new RegExp(ERROR_HEADER_PATTERN);
export const EXCERPT_LINE_RE = new RegExp(EXCERPT_LINE_PATTERN);
export const ERROR_NAME_LINE_RE = new RegExp(ERROR_NAME_LINE_PATTERN);
export const STACK_FRAME_RE = new RegExp(STACK_FRAME_PATTERN);
export const TRAILING_TRACE_RE = new RegExp(TRAILING_TRACE_PATTERN);

/** What one physical line is to the entry being built. */
export const LineRole = {
  /** Starts a new entry. */
  Start: "start",
  /** Always belongs to the entry before it. */
  Continuation: "continuation",
  /** Belongs to the entry before it only after an error header or a template excerpt. */
  Detail: "detail",
} as const;
export type LineRole = (typeof LineRole)[keyof typeof LineRole];

/** The role of a line seen on its own (no look at the line before). */
export function lineRole(line: string): LineRole {
  if (SOLO_RE.test(line)) return LineRole.Start;
  if (CONTINUATION_RE.test(line)) return LineRole.Continuation;
  if (ERROR_NAME_LINE_RE.test(line)) return LineRole.Detail;
  return LineRole.Start;
}
