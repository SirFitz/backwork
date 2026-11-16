/** Fixed value sets for error groups (BAC-85). Client-safe: no Node imports. */

/** Where an error group's events come from. */
export const ErrorSource = {
  /** POSTed to /ingest/errors by the service itself. */
  Reported: "reported",
  /** An error- or fatal-level log line. */
  Log: "log",
  /** An inbound request whose end record has a 5xx status. */
  Request: "request",
} as const;
export type ErrorSource = (typeof ErrorSource)[keyof typeof ErrorSource];

export const ERROR_SOURCES: readonly ErrorSource[] = Object.values(ErrorSource);

export function isErrorSource(v: unknown): v is ErrorSource {
  return typeof v === "string" && (ERROR_SOURCES as readonly string[]).includes(v);
}

/** Log levels as backwork names them. Only Error and Fatal lines become error events. */
export const LogLevel = {
  Trace: "trace",
  Debug: "debug",
  Info: "info",
  Warn: "warn",
  Error: "error",
  Fatal: "fatal",
} as const;
export type LogLevel = (typeof LogLevel)[keyof typeof LogLevel];

/** The level an error group shows (the existing column's values). */
export const ErrorLevel = { Fatal: "fatal", Error: "error", Warning: "warning", Info: "info" } as const;
export type ErrorLevel = (typeof ErrorLevel)[keyof typeof ErrorLevel];
