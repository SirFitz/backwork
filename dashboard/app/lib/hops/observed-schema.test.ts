import { describe, expect, test } from "bun:test";
import { buildObservedSchema, columnsByUse, relationsOf, searchTables, tableOf, usualCompanions } from "./observed-schema";
import { statementShape } from "./stmt-shape";

const rows = [
  { shape: statementShape(`select * from orders where merchant_id = 1 and status = 'paid' order by created_at desc limit 20`), calls: 100 },
  { shape: statementShape(`select count(*) from orders where merchant_id = 2 and status in ('open','paid')`), calls: 60 },
  { shape: statementShape(`select * from orders where merchant_id = 3`), calls: 40 },
  { shape: statementShape(`select m.id from merchants m inner join orders o on o.merchant_id = m.id where m.username = 'x'`), calls: 10 },
  { shape: statementShape(`select * from merchants as m join orders as o on m.id = o.merchant_id where m.id = 4`), calls: 5 },
  { shape: statementShape(`update orders set status = 'x' where id = 9`), calls: 7 },
  { shape: "begin", calls: 3 },
];

describe("buildObservedSchema", () => {
  const s = buildObservedSchema(rows);
  test("tables with reads, writes and shapes, busiest first", () => {
    expect(s.tables.map((t) => t.name)).toEqual(["orders", "merchants"]);
    const orders = tableOf(s, "orders")!;
    expect(orders.reads).toBe(215);
    expect(orders.writes).toBe(7);
    expect(orders.shapes).toBe(6);
    expect(s.shapesSkipped).toBe(1);
  });
  test("columns count where, equality, order and join uses by call", () => {
    const orders = tableOf(s, "orders")!;
    expect(orders.columns.merchant_id).toEqual({ where: 200, whereEqual: 200, join: 15, orderBy: 0, groupBy: 0 });
    expect(orders.columns.created_at.orderBy).toBe(100);
    expect(columnsByUse(orders)[0].name).toBe("merchant_id");
  });
  test("relations merge both spellings of one join", () => {
    expect(s.relations).toHaveLength(1);
    expect(s.relations[0]).toMatchObject({ calls: 15, from: { table: "merchants", column: "id" }, to: { table: "orders", column: "merchant_id" } });
    expect(relationsOf(s, "orders")).toHaveLength(1);
  });
  test("columns filtered together", () => {
    const orders = tableOf(s, "orders")!;
    expect(orders.filteredTogether["merchant_id|status"]).toBe(160);
    expect(usualCompanions(orders, "merchant_id", 10, 0.7)).toEqual(["status"]);
    expect(usualCompanions(orders, "merchant_id", 10, 0.9)).toEqual([]);
    expect(usualCompanions(orders, "merchant_id", 1000, 0.1)).toEqual([]);
  });
  test("search matches table and column names", () => {
    expect(searchTables(s, "usern").map((t) => t.name)).toEqual(["merchants"]);
    expect(searchTables(s, "").length).toBe(2);
  });
});

import { schemaPage } from "./observed-schema";

describe("schemaPage", () => {
  const many = buildObservedSchema(Array.from({ length: 30 }, (_, i) => ({ shape: `select * from t${String(i).padStart(2, "0")} where a = ?`, calls: 30 - i })));
  test("pages in order of use and clamps the page", () => {
    const p1 = schemaPage(many, "", 1, 12);
    expect(p1.tables).toHaveLength(12);
    expect(p1.tables[0].name).toBe("t00");
    expect(p1.pages).toBe(3);
    expect(schemaPage(many, "", 99, 12).page).toBe(3);
    expect(schemaPage(many, "", -4, 12).page).toBe(1);
  });
  test("search narrows before paging", () => {
    const s = schemaPage(many, "t2", 1, 12);
    expect(s.total).toBe(10);
    expect(s.pages).toBe(1);
  });
});
