import { describe, expect, test } from "bun:test";
import { hasStatementFields, sharedDatabaseHost, statementTail, storeLabel } from "./store-label";
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

describe("statementTail: the statement after the table the label already names", () => {
  const tail = (table: string | null, stmt: string | null) => statementTail(db("x", table, stmt));
  test("the spec's Ecto example keeps the alias and the conditions", () => {
    expect(tail("merchants", "select ... from merchants as m0 where (m0.username = ?) limit ?")).toBe("as m0 where (m0.username = ?) limit ?");
  });
  test("a select with columns", () => {
    expect(tail("merchants", "select m0.status from merchants as m0 where (lower(m0.username) = ?)")).toBe("as m0 where (lower(m0.username) = ?)");
    expect(tail("posts", "select count(*)::int from posts where (posts.site_id = ?)")).toBe("where (posts.site_id = ?)");
  });
  test("an insert with returning", () => {
    expect(tail("orders", "insert into orders (merchant_id, total) values (?, ?) returning id")).toBe("(merchant_id, total) values (?, ?) returning id");
  });
  test("an update and a delete", () => {
    expect(tail("orders", "update orders set status = ? where id = ?")).toBe("set status = ? where id = ?");
    expect(tail("sessions", "delete from sessions where expires_at < ?")).toBe("where expires_at < ?");
  });
  test("a join: the rest from the alias on", () => {
    expect(tail("tokens", "select ... from tokens as t0 left outer join users as u1 on u1.id = t0.user_id")).toBe("as t0 left outer join users as u1 on u1.id = t0.user_id");
  });
  test("a table name that also appears later is cut at its first place only", () => {
    expect(tail("orders", "select ... from orders as o0 where o0.id in (select order_id from orders_archive) and orders.x = ?")).toBe("as o0 where o0.id in (select order_id from orders_archive) and orders.x = ?");
  });
  test("schema prefixes and quotes", () => {
    expect(tail("merchants", 'select ... from "public"."merchants" as m0 where (m0.id = ?)')).toBe("as m0 where (m0.id = ?)");
    expect(tail("public.merchants", "select ... from public.merchants where id = ?")).toBe("where id = ?");
  });
  test("nothing after the table shows nothing", () => {
    expect(tail("site_categories", "select id, name from site_categories")).toBe("");
  });
  test("a head that does not match shows the whole statement", () => {
    expect(tail("merchants", "with recent as (select ... from merchants) select ... from recent")).toBe("with recent as (select ... from merchants) select ... from recent");
    expect(tail("merchants", "select ... from (select ... from merchants) as s where s.x = ?")).toBe("select ... from (select ... from merchants) as s where s.x = ?");
    expect(tail("merchants", "select ... from merchants_archive as m0")).toBe("select ... from merchants_archive as m0");
  });
  test("a statement with no table, and no statement", () => {
    expect(tail(null, "select ?")).toBe("select ?");
    expect(tail(null, null)).toBeNull();
  });
});
