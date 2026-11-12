// An idle Postgres connection can be closed by the server at any time (a restart, an
// administrator, a network drop). pg's Pool then emits "error"; with no listener Node treats it
// as an uncaught exception and the whole dashboard exits (BAC-41 row 21). The pool already
// discards the broken client and opens a new one on the next query, so the right response is to
// log it and carry on.

/** The part of pg.Pool this needs. */
export interface ErrorEmitter {
  on(event: "error", listener: (err: Error) => void): unknown;
}

export type Warn = (message: string) => void;

/** Attach the listener; returns the pool for chaining. */
export function survivePoolErrors<P extends ErrorEmitter>(pool: P, warn: Warn = (m) => console.warn(m)): P {
  pool.on("error", (err: Error) => {
    warn(`postgres: an idle connection closed (${err.message}); the pool reconnects on the next query`);
  });
  return pool;
}
