import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import pg from "pg";
import { survivePoolErrors } from "./pool-errors.server";

describe("survivePoolErrors (BAC-41 row 21)", () => {
  test("an error event on the pool is logged, not thrown", () => {
    const warnings: string[] = [];
    const pool = survivePoolErrors(new EventEmitter(), (m) => warnings.push(m));
    expect(() => pool.emit("error", new Error("terminating connection due to administrator command"))).not.toThrow();
    expect(warnings[0]).toContain("terminating connection due to administrator command");
  });
  test("without the listener the same event throws (what took the process down)", () => {
    expect(() => new EventEmitter().emit("error", new Error("x"))).toThrow();
  });
  // Against a real Postgres when one is given: an idle connection terminated by the server.
  const url = process.env.POOL_TEST_DATABASE_URL;
  test.skipIf(!url)("a real idle connection terminated by the server does not take the process down", async () => {
    const warnings: string[] = [];
    const pool = survivePoolErrors(new pg.Pool({ connectionString: url, max: 1, idleTimeoutMillis: 60_000 }), (m) => warnings.push(m));
    const pid = (await pool.query<{ pid: number }>("select pg_backend_pid() as pid")).rows[0].pid;
    const admin = new pg.Client({ connectionString: url });
    await admin.connect();
    await admin.query("select pg_terminate_backend($1)", [pid]);
    await admin.end();
    await new Promise((r) => setTimeout(r, 500));
    expect(warnings.length).toBe(1);
    expect((await pool.query<{ one: number }>("select 1 as one")).rows[0].one).toBe(1);
    await pool.end();
  });
});
