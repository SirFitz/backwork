import { describe, expect, test } from "bun:test";
import { hasStatementFields, sharedDatabaseHost, storeLabel } from "./store-label";
import type { Via } from "./types";

const db = (op: string, table: string | null, stmt: string | null, peer: string | null = "db.internal") => ({ via: "db" as Via, isStore: true, op, table, stmt, peer });

describe("storeLabel (design 21)", () => {
  test("command and table", () => {
    expect(storeLabel(db("select", "merchants", "select ... from merchants as m0 where (m0.username = ?) limit ?"))).toBe("select merchants");
  });
  test("command alone when there is no table", () => {
    expect(storeLabel(db("begin", null, "begin"))).toBe("begin");
  });
  test("a record without the fields reads as before: command and host", () => {
    expect(storeLabel(db("select", null, null))).toBe("select db.internal");
  });
  test("a cache row reads as before", () => {
    expect(storeLabel({ via: "cache" as Via, op: "get", peer: "redis.internal", table: null, stmt: null })).toBe("get redis.internal");
    expect(hasStatementFields({ via: "cache" as Via, table: "x", stmt: "y" })).toBe(false);
  });
});

describe("sharedDatabaseHost", () => {
  test("shown once when every database row shares the host", () => {
    expect(sharedDatabaseHost([db("select", "a", "s"), db("insert", "b", "i")])).toBe("db.internal");
  });
  test("none when hosts differ or a row has no host", () => {
    expect(sharedDatabaseHost([db("select", "a", "s"), db("insert", "b", "i", "other-db")])).toBeNull();
    expect(sharedDatabaseHost([db("select", "a", "s", null)])).toBeNull();
  });
  test("none when no row has the fields (old records keep the host on the row)", () => {
    expect(sharedDatabaseHost([db("select", null, null)])).toBeNull();
  });
});
