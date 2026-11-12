import { describe, expect, test } from "bun:test";
import { meta } from "~/routes/_index";

type MetaArgs = Parameters<typeof meta>[0];
const titleOf = (data: unknown): string | undefined => {
  const tags = meta({ data } as unknown as MetaArgs) as Array<Record<string, string>>;
  return tags.find((t) => "title" in t)?.title;
};

describe("Overview tab title (BAC-41 row 20)", () => {
  test("signed in: the page's own title", () => {
    expect(titleOf({ reporting: Promise.resolve(null) })).toBe("Overview · backwork");
  });
  test("visitors: the public headline", () => {
    expect(titleOf({ marketing: true })).toContain("follow any request");
  });
});
