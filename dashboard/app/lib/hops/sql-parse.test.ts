// BAC-93: the shape reader. Inputs are real shapes as `statementShape` writes them.
import { describe, expect, test } from "bun:test";
import { PredicateOp, SqlVerb, equalityColumns, parseShape } from "./sql-parse";
import { statementShape } from "./stmt-shape";

const shapeOf = (stmt: string) => parseShape(statementShape(stmt));

describe("parseShape", () => {
  test("a lookup by one column, through an alias", () => {
    const p = shapeOf(`SELECT "Merchant"."id", "Merchant"."username" FROM "merchants" AS "Merchant" WHERE "Merchant"."username" = 'zed' LIMIT 1;`);
    expect(p?.verb).toBe(SqlVerb.Select);
    expect(p?.tables).toEqual([{ name: "merchants", alias: "merchant" }]);
    expect(p?.where).toEqual([{ column: { table: "merchants", column: "username" }, op: PredicateOp.Equal, fn: null, inOr: false }]);
    expect(p?.limited).toBe(true);
    expect(p?.complex).toBe(false);
  });

  test("a function around the column is kept as fn", () => {
    const p = shapeOf(`select id from merchants where lower(merchants.username) = $1`);
    expect(p?.where[0]).toMatchObject({ column: { table: "merchants", column: "username" }, fn: "lower", op: PredicateOp.Equal });
  });

  test("a join and its filters, with order and group", () => {
    const p = shapeOf(
      `select o.id, sum(i.qty) from orders o inner join order_items i on i.order_id = o.id where o.merchant_id = 7 and o.status in ('paid','open') and o.created_at > '2026-01-01' group by o.id order by o.created_at desc limit 20`,
    );
    expect(p?.tables.map((t) => t.name)).toEqual(["orders", "order_items"]);
    expect(p?.joins).toEqual([{ left: { table: "order_items", column: "order_id" }, right: { table: "orders", column: "id" } }]);
    expect(p?.where.map((w) => `${w.column.column}:${w.op}`)).toEqual(["merchant_id:equal", "status:equal", "created_at:range"]);
    expect(p?.groupBy).toEqual([{ table: "orders", column: "id" }]);
    expect(p?.orderBy).toEqual([{ table: "orders", column: "created_at" }]);
    expect(equalityColumns(p!, "orders")).toEqual(["merchant_id", "status"]);
  });

  test("OR branches are marked and not counted as equality columns", () => {
    const p = shapeOf(`select * from users where (email = 'a' or phone = 'b') and active = true`);
    expect(p?.where.filter((w) => w.inOr).map((w) => w.column.column)).toEqual(["email", "phone"]);
    expect(equalityColumns(p!, "users")).toEqual([]);
  });

  test("update, delete and insert", () => {
    expect(shapeOf(`update plans set name = 'x' where id = 4`)?.tables[0].name).toBe("plans");
    expect(shapeOf(`delete from sessions where user_id = 9`)?.where[0].column).toEqual({ table: "sessions", column: "user_id" });
    const ins = shapeOf(`insert into audit_events (a, b) values (1, 'x') returning id`);
    expect(ins?.verb).toBe(SqlVerb.Insert);
    expect(ins?.returning).toBe(true);
    expect(ins?.tables[0].name).toBe("audit_events");
  });

  test("a subquery is complex; other text is not a statement", () => {
    expect(shapeOf(`select * from a where id in (select id from b where x = 1)`)?.complex).toBe(true);
    expect(parseShape("begin")).toBeNull();
    expect(parseShape("")).toBeNull();
  });

  test("schema-qualified tables use the table name", () => {
    expect(shapeOf(`select id from "public"."merchants" where "public"."merchants"."id" = 1`)?.tables[0].name).toBe("merchants");
  });
});
