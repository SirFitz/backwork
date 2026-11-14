import { describe, expect, test } from "bun:test";
import { SHAPE_LABEL_CHARS, shapeId, shapeLabel, statementShape } from "./stmt-shape";

describe("statementShape", () => {
  test("lowercases and collapses whitespace", () => {
    expect(statementShape("SELECT  id\n  FROM\tplans   WHERE plans.number = ?")).toBe("select id from plans where plans.number = ?");
  });

  test("bare numbers become ?, names with digits stay", () => {
    expect(statementShape("select m0.id from merchants as m0 where m0.id = 42 limit 10")).toBe("select m0.id from merchants as m0 where m0.id = ? limit ?");
    expect(statementShape("select * from orders_2024 where total > 12.50")).toBe("select * from orders_2024 where total > ?");
  });

  test("string literals and numbered placeholders become ?", () => {
    expect(statementShape("select id from users where email = 'a@b.c' and id = $1")).toBe("select id from users where email = ? and id = ?");
    expect(statementShape("select id from users where name = 'O''Brien'")).toBe("select id from users where name = ?");
  });

  test("in lists collapse to one ?", () => {
    expect(statementShape("select id from plans where id in (?, ?, ?)")).toBe("select id from plans where id in (?)");
    expect(statementShape("select id from plans where id IN (1,2,3,4)")).toBe("select id from plans where id in (?)");
    expect(statementShape("select id from plans where id in ( $1 , $2 )")).toBe("select id from plans where id in (?)");
    expect(statementShape("select id from plans where id in (?)")).toBe("select id from plans where id in (?)");
  });

  test("values lists collapse to one ?, multi-row too", () => {
    expect(statementShape("insert into charges (id, amount, status) values (?, ?, ?)")).toBe("insert into charges (id, amount, status) values (?)");
    expect(statementShape("INSERT INTO charges (id, amount) VALUES ($1, $2), ($3, $4)")).toBe("insert into charges (id, amount) values (?)");
  });

  test("trailing semicolons are dropped", () => {
    expect(statementShape("select 1;")).toBe("select ?");
    expect(statementShape("select id from plans ; ; ")).toBe("select id from plans");
  });

  test("spacing around brackets, commas and operators is uniform", () => {
    expect(statementShape("update orders set status=? where a=? and b<>?")).toBe("update orders set status = ? where a = ? and b <> ?");
    expect(statementShape("select count( * ) from t where x >=?")).toBe("select count(*) from t where x >= ?");
  });

  test("adapter variants of one query give one shape", () => {
    const variants = [
      "select id, number from plans where plans.number = ?",
      'SELECT "id", "number" FROM "plans" WHERE "plans"."number" = $1',
      "select `id`,`number` from `plans` where `plans`.`number`=5;",
      "select id ,number\nfrom plans\nwhere plans.number = 17",
    ];
    const shapes = new Set(variants.map(statementShape));
    expect(shapes.size).toBe(1);
    expect([...shapes][0]).toBe("select id, number from plans where plans.number = ?");
  });

  test("two different tables never merge", () => {
    expect(statementShape("select id from plans where id = ?")).not.toBe(statementShape("select id from orders where id = ?"));
    expect(statementShape("select id from plans where id in (1, 2)")).not.toBe(statementShape("select id from plan where id in (1, 2)"));
  });

  test("an Ecto statement keeps its elided column list", () => {
    expect(statementShape("select ... from merchants as m0 where (m0.username = ?) limit ?")).toBe("select ... from merchants as m0 where (m0.username = ?) limit ?");
  });

  test("is idempotent", () => {
    const once = statementShape("SELECT * FROM t WHERE a IN (1, 2) AND b = 'x';");
    expect(statementShape(once)).toBe(once);
  });
});

describe("shapeId", () => {
  test("is 8 hex characters and stable", () => {
    const id = shapeId("select id from plans where plans.number = ?");
    expect(id).toMatch(/^[0-9a-f]{8}$/);
    expect(shapeId("select id from plans where plans.number = ?")).toBe(id);
  });

  test("matches the FNV-1a reference values", () => {
    expect(shapeId("")).toBe("811c9dc5");
    expect(shapeId("a")).toBe("e40c292c");
    expect(shapeId("foobar")).toBe("bf9cf968");
  });

  test("different shapes give different ids", () => {
    expect(shapeId("select id from plans")).not.toBe(shapeId("select id from orders"));
  });

  test("hashes UTF-8 bytes, not UTF-16 units", () => {
    // FNV-1a 32 of the bytes c3 a9 ("é").
    expect(shapeId("é")).toBe("1e9de8c1");
  });
});

describe("shapeLabel", () => {
  test("a short shape is returned as is", () => {
    expect(shapeLabel("select id from plans", 40)).toBe("select id from plans");
  });

  test("a long shape is cut at a word boundary with an ellipsis", () => {
    const label = shapeLabel("select id, number from plans where plans.number = ?", 24);
    expect(label).toBe("select id, number from…");
    expect(label.length).toBeLessThanOrEqual(24);
  });

  test("a single long word is cut hard", () => {
    expect(shapeLabel("abcdefghijklmnop", 6)).toBe("abcde…");
  });

  test("defaults to SHAPE_LABEL_CHARS", () => {
    const long = "select a from b where c = ? ".repeat(10).trim();
    expect(shapeLabel(long).length).toBeLessThanOrEqual(SHAPE_LABEL_CHARS);
  });
});
