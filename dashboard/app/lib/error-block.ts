/**
 * Reads an error out of a joined multi-line log entry (BAC-94): the exception's name, its message
 * and its stack. Pure and client-safe.
 *
 *   [error] Uncaught in GET /help | GET /help | company 12 | user 34     <- header (the group title)
 *   ReferenceError: /app/views/pages/help.ejs:1                          <- Name: message
 *    >> 1| <%- include(partialhead); %>                                  <- template excerpt
 *       2| <script ...>
 *                                                                        <- blank
 *   partialhead is not defined                                           <- the template's message
 *       at eval (/app/views/pages/help.ejs:10:25)                        <- stack
 *   extra: {...}                                                         <- not part of the stack
 */
import { ERROR_NAME_LINE_RE, EXCERPT_LINE_RE, STACK_FRAME_RE, TRAILING_TRACE_RE } from "~/lib/log-join";

/** Most lines and characters kept of a stack. */
export const STACK_MAX_LINES = 60;
export const STACK_MAX_CHARS = 8000;
const NAME_MAX = 200;
const MESSAGE_MAX = 2000;

export interface ParsedError {
  /** `ReferenceError`, `ApiError`, `TypeError`, … */
  type: string;
  /** The exception's own message (`partialhead is not defined`). */
  message: string;
  /** The template excerpt and `at …` frames, or null when the entry has none. */
  stack: string | null;
}

const EXTRA_LINE = /^extra: /;
/** ejs puts the template's location where the message would be: `/app/views/x.ejs:1`. */
const TEMPLATE_LOCATION = /^\S+\.(?:ejs|pug|hbs|handlebars|njk|eta|liquid):\d+$/;

function clean(line: string): string {
  return line.replace(TRAILING_TRACE_RE, "");
}

function capStack(lines: readonly string[]): string | null {
  const kept = lines.slice(0, STACK_MAX_LINES);
  while (kept.length && kept[kept.length - 1].trim() === "") kept.pop();
  while (kept.length && kept[0].trim() === "") kept.shift();
  if (!kept.length) return null;
  const more = lines.length > STACK_MAX_LINES ? `\n… ${lines.length - STACK_MAX_LINES} more lines` : "";
  return (kept.join("\n") + more).slice(0, STACK_MAX_CHARS);
}

/**
 * The error in a multi-line entry: the first `Name: message` line (the first line itself counts),
 * the message (the template's message when an excerpt sits between them) and the stack.
 * Null for a one-line entry or one without such a line.
 */
export function parseErrorBlock(text: string): ParsedError | null {
  const lines = text.split("\n").map(clean);
  if (lines.length < 2) return null;
  const at = lines.findIndex((l) => ERROR_NAME_LINE_RE.test(l));
  if (at < 0) return null;
  const m = ERROR_NAME_LINE_RE.exec(lines[at])!;
  const type = m[1].slice(0, NAME_MAX);
  let message = m[2].trim();
  const rest = lines.slice(at + 1).filter((l) => !EXTRA_LINE.test(l));

  const stack: string[] = [];
  const tail: string[] = [];
  let excerpt = false;
  for (const l of rest) {
    if (EXCERPT_LINE_RE.test(l)) {
      excerpt = true;
      stack.push(l);
    } else if (STACK_FRAME_RE.test(l)) {
      stack.push(l);
    } else if (l.trim() === "") {
      if (stack.length) stack.push(l);
    } else if (/^\s/.test(l)) {
      stack.push(l);
    } else if (excerpt && !stack.some((s) => STACK_FRAME_RE.test(s))) {
      // The template's own message, printed after the excerpt and a blank line.
      tail.push(l.trim());
    } else {
      stack.push(l);
    }
  }
  if (tail.length) {
    // ejs: the location takes the message's place; the real message is the tail.
    if (TEMPLATE_LOCATION.test(message)) stack.unshift(`in ${message}`);
    message = TEMPLATE_LOCATION.test(message) || message === "" ? tail.join(" ") : `${message}: ${tail.join(" ")}`;
  }
  return { type, message: message.slice(0, MESSAGE_MAX), stack: capStack(stack) };
}

/** A JSON logger's stack (pino `err.stack`, `error.stack`, winston's top-level `stack`), without
 *  its own first `Name: message` line. */
export function stackOfJson(obj: Readonly<Record<string, unknown>>): string | null {
  const holders = [obj.err, obj.error, obj];
  for (const h of holders) {
    if (typeof h !== "object" || h === null || Array.isArray(h)) continue;
    const s = (h as Record<string, unknown>).stack;
    if (typeof s !== "string" || s.trim() === "") continue;
    const lines = s.split("\n");
    if (ERROR_NAME_LINE_RE.test(lines[0]) && lines.length > 1) lines.shift();
    return capStack(lines);
  }
  return null;
}
