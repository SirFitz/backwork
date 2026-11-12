import { describe, expect, test } from "bun:test";
import { IdRejection, IdRule, toTraceId, traceIdFromTraceparent } from "./id";

describe("toTraceId: normative examples (spec section 4)", () => {
  const cases: Array<[string, IdRule, string]> = [
    ["4BF92F3577B34DA6A3CE929D0E0E4736", IdRule.Hex, "4bf92f3577b34da6a3ce929d0e0e4736"],
    ["123e4567-e89b-12d3-a456-426614174000", IdRule.Uuid, "123e4567e89b12d3a456426614174000"],
    ["F8Zx2o1yQk0AAAEB", IdRule.Derived, "6503f5f183b828139d5b143365ad72fa"],
    ["order-7731", IdRule.Derived, "a4d98b610c95118b9dbd276f51462b66"],
    ["abc", IdRule.Derived, "a5747684d61d59e75e7ced1cae4dc94e"],
    ["01ARZ3NDEKTSV4RRFFQ69G5FAV", IdRule.Derived, "98aec2f479fe2e232c46210fe23500df"],
  ];
  for (const [input, rule, expected] of cases) {
    test(input, () => {
      const r = toTraceId(input);
      expect(r).toEqual({ ok: true, traceId: expected, rule, input });
    });
  }
});

describe("toTraceId: traceparent", () => {
  test("version 00 gives its trace ID part", () => {
    const r = toTraceId("00-6503f5f183b828139d5b143365ad72fa-b7ad6b7169203331-01");
    expect(r.ok && r.traceId).toBe("6503f5f183b828139d5b143365ad72fa");
    expect(r.ok && r.rule).toBe(IdRule.Traceparent);
  });
  test("a later version may be longer when byte 56 is '-'", () => {
    expect(traceIdFromTraceparent("01-6503f5f183b828139d5b143365ad72fa-b7ad6b7169203331-01-extra")).toBe("6503f5f183b828139d5b143365ad72fa");
    expect(traceIdFromTraceparent("01-6503f5f183b828139d5b143365ad72fa-b7ad6b7169203331-01x")).toBeNull();
  });
  test("invalid traceparents are not read as traceparents", () => {
    expect(traceIdFromTraceparent("ff-6503f5f183b828139d5b143365ad72fa-b7ad6b7169203331-01")).toBeNull();
    expect(traceIdFromTraceparent("00-6503F5F183B828139D5B143365AD72FA-b7ad6b7169203331-01")).toBeNull();
    expect(traceIdFromTraceparent("00-00000000000000000000000000000000-b7ad6b7169203331-01")).toBeNull();
    expect(traceIdFromTraceparent("00-6503f5f183b828139d5b143365ad72fa-0000000000000000-01")).toBeNull();
    expect(traceIdFromTraceparent("00-6503f5f183b828139d5b143365ad72fa-b7ad6b7169203331-01-")).toBeNull();
  });
  test("an invalid traceparent falls through to rule 3", () => {
    const r = toTraceId("ff-6503f5f183b828139d5b143365ad72fa-b7ad6b7169203331-01");
    expect(r.ok && r.rule).toBe(IdRule.Derived);
  });
});

describe("toTraceId: boundaries and rejections", () => {
  test("surrounding spaces are trimmed", () => {
    const r = toTraceId("  F8Zx2o1yQk0AAAEB\t");
    expect(r.ok && r.traceId).toBe("6503f5f183b828139d5b143365ad72fa");
  });
  test("empty input is rejected", () => {
    expect(toTraceId("   ")).toMatchObject({ ok: false, reason: IdRejection.Empty });
  });
  test("200 characters is accepted, 201 rejected", () => {
    expect(toTraceId("a".repeat(200)).ok).toBe(true);
    expect(toTraceId("a".repeat(201))).toMatchObject({ ok: false, reason: IdRejection.TooLong });
  });
  test("inner spaces, control and non-ASCII characters are rejected", () => {
    expect(toTraceId("order 7731")).toMatchObject({ ok: false, reason: IdRejection.BadCharacter });
    expect(toTraceId("order\u00007731")).toMatchObject({ ok: false, reason: IdRejection.BadCharacter });
    expect(toTraceId("ordér")).toMatchObject({ ok: false, reason: IdRejection.BadCharacter });
    expect(toTraceId("{kind=\"hop\"}|=\"x\"")).toMatchObject({ ok: true, rule: IdRule.Derived });
  });
  test("an all-zero 32-hex value and the nil UUID are not used as trace IDs (rule 3 applies)", () => {
    const zeros = toTraceId("00000000000000000000000000000000");
    expect(zeros.ok && zeros.rule).toBe(IdRule.Derived);
    expect(zeros.ok && zeros.traceId).not.toBe("00000000000000000000000000000000");
    const nil = toTraceId("00000000-0000-0000-0000-000000000000");
    expect(nil.ok && nil.rule).toBe(IdRule.Derived);
  });
  test("31 and 33 hex characters are derived, not taken as is", () => {
    expect(toTraceId("4bf92f3577b34da6a3ce929d0e0e473").ok && toTraceId("4bf92f3577b34da6a3ce929d0e0e473")).toMatchObject({ rule: IdRule.Derived });
    expect(toTraceId("4bf92f3577b34da6a3ce929d0e0e47360")).toMatchObject({ rule: IdRule.Derived });
  });
  test("the result is always 32 lowercase hex", () => {
    for (const v of ["x", "A-B_C.d", "~!@#$%^&*()", "4BF92F3577B34DA6A3CE929D0E0E4736"]) {
      const r = toTraceId(v);
      expect(r.ok && /^[0-9a-f]{32}$/.test(r.traceId)).toBe(true);
    }
  });
});
