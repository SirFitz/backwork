// Excluded paths (BAC-82): requests whose path matches are dropped on the customer's server by the
// agent, before anything is sent, and again by backwork's ingest route. Pure (no I/O): validation,
// matching, and the regex sources the agent's Vector config is generated from, so the agent and
// ingest can never disagree about what matches.
//
// A pattern is a path that starts with "/": an exact path ("/health") or one with "*" wildcards
// ("/socket.io/*", "/assets/*.js"). "*" matches any run of characters, "/" included. A request's
// query string and fragment are ignored ("/health" matches "/health?probe=1").
//
// Every regex here is written in the subset JavaScript and Rust regex (Vector's VRL) both read.

/** Longest pattern accepted. */
export const MAX_EXCLUDED_PATH_LENGTH = 200;

/** Most patterns one scope (the organisation, or one project) can hold. */
export const MAX_EXCLUDED_PATHS = 100;

/** The wildcard. */
export const WILDCARD = "*";

/** Reasons a pattern is refused. */
export const ExcludedPathError = {
  Empty: "path_empty",
  NoSlash: "path_no_slash",
  TooLong: "path_too_long",
  BadCharacters: "path_bad_characters",
  MatchesEverything: "path_matches_everything",
  Duplicate: "path_duplicate",
  TooMany: "path_too_many",
} as const;
export type ExcludedPathError = (typeof ExcludedPathError)[keyof typeof ExcludedPathError];

/** What the person sees for each refusal. */
export const EXCLUDED_PATH_ERROR_TEXT: Record<ExcludedPathError, string> = {
  [ExcludedPathError.Empty]: "Enter a path.",
  [ExcludedPathError.NoSlash]: "A path starts with /, for example /health.",
  [ExcludedPathError.TooLong]: `A path is at most ${MAX_EXCLUDED_PATH_LENGTH} characters.`,
  [ExcludedPathError.BadCharacters]: "Use the path only: letters, digits, / and * (no spaces, ? or #).",
  [ExcludedPathError.MatchesEverything]: "That would drop every request. Name the part of the path to leave out.",
  [ExcludedPathError.Duplicate]: "That path is already excluded.",
  [ExcludedPathError.TooMany]: `At most ${MAX_EXCLUDED_PATHS} excluded paths per project.`,
};

export function isExcludedPathError(v: string): v is ExcludedPathError {
  return (Object.values(ExcludedPathError) as string[]).includes(v);
}

/** Path characters of RFC 3986 (unreserved, percent, sub-delims, ":" "@" "/"), "*" included. */
const PATH_CHARS = /^[A-Za-z0-9\-._~%!$&'()*+,;=:@/]+$/;

/** Trim surrounding space; the stored form of a pattern. */
export function normalizeExcludedPath(input: string): string {
  return input.trim();
}

/** Validate one pattern. Returns null when it is acceptable. */
export function validateExcludedPath(pattern: string): ExcludedPathError | null {
  if (pattern === "") return ExcludedPathError.Empty;
  if (!pattern.startsWith("/")) return ExcludedPathError.NoSlash;
  if (pattern.length > MAX_EXCLUDED_PATH_LENGTH) return ExcludedPathError.TooLong;
  if (!PATH_CHARS.test(pattern)) return ExcludedPathError.BadCharacters;
  if (pattern.includes(WILDCARD) && /^[/*]+$/.test(pattern)) return ExcludedPathError.MatchesEverything;
  return null;
}

/** Regex metacharacters a path may contain; "/" and "-" need no escape. */
const REGEX_META = /[.+?^$()[\]{}|\\]/g;

/** One pattern as a regex body, with WILD standing in for each "*". */
function patternBody(pattern: string, wild: string): string {
  return pattern
    .split(WILDCARD)
    .map((part) => part.replace(REGEX_META, (c) => `\\${c}`))
    .join(wild);
}

/** Characters that end a path inside a log line. */
const LINE_STOP = `\\s"'?#,;)\\]`;

/**
 * The regex source a whole path (query string removed) must match: every pattern, anchored.
 * Null when there are no patterns.
 */
export function pathMatchSource(patterns: readonly string[]): string | null {
  if (!patterns.length) return null;
  return `^(?:${patterns.map((p) => patternBody(p, ".*")).join("|")})$`;
}

/**
 * The regex source for an ordinary log line that mentions a matching path ("GET /health 200",
 * `"url":"/socket.io/?EIO=4"`). Best effort: the path must stand on its own (start of line, after a
 * space, quote, "=", "(" or "["), and "*" does not run past a space or quote. Null when there are
 * no patterns.
 */
export function lineMatchSource(patterns: readonly string[]): string | null {
  if (!patterns.length) return null;
  const body = patterns.map((p) => patternBody(p, `[^${LINE_STOP}]*`)).join("|");
  return `(?:^|[\\s"'=(\\[])(?:${body})(?:$|[${LINE_STOP}])`;
}

/** Remove the query string and fragment of a request path. */
export function stripQuery(path: string): string {
  const cut = path.search(/[?#]/);
  return cut === -1 ? path : path.slice(0, cut);
}

/** Compiled patterns, for the ingest path. */
export interface ExcludedPathMatcher {
  readonly patterns: readonly string[];
  /** Whole-path match: hop records' `path` and `op`. */
  readonly path: RegExp | null;
  /** Mention inside an ordinary log line. */
  readonly line: RegExp | null;
}

export function compileExcludedPaths(patterns: readonly string[]): ExcludedPathMatcher {
  const p = pathMatchSource(patterns);
  const l = lineMatchSource(patterns);
  return { patterns, path: p ? new RegExp(p) : null, line: l ? new RegExp(l) : null };
}

/** Does a request path (or route template) match? Query string ignored. */
export function pathExcluded(m: ExcludedPathMatcher, path: string | null | undefined): boolean {
  if (!m.path || typeof path !== "string" || path === "") return false;
  return m.path.test(stripQuery(path));
}

/** Does an ordinary log line mention a matching request path? */
export function lineExcluded(m: ExcludedPathMatcher, line: string): boolean {
  return m.line !== null && m.line.test(line);
}
