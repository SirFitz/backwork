import { describe, expect, test } from "bun:test";
import { BUCKET_SECONDS, bucketStart, windowCutoff, type Bucket } from "./window";

const B = BUCKET_SECONDS;
const mk = (rows: Array<[number, number]>): Bucket[] => rows.map(([requests, bytes], i) => ({ startS: i * B, requests, bytes }));

describe("bucketStart", () => {
  test("floors to the 5-minute bucket, in unix seconds", () => {
    expect(bucketStart(Date.UTC(2026, 10, 13, 10, 7, 31))).toBe(Date.UTC(2026, 10, 13, 10, 5) / 1000);
  });
});

describe("windowCutoff", () => {
  test("null when it all fits", () => expect(windowCutoff(mk([[10, 10], [10, 10]]), 100, 1000)).toBeNull());
  test("null with no buckets", () => expect(windowCutoff([], 100, 100)).toBeNull());
  test("cuts at the request cap: keeps the newest buckets up to it", () => {
    // newest first: 40, 40 (=80), then +40 = 120 > 100
    expect(windowCutoff(mk([[40, 1], [40, 1], [40, 1], [40, 1]]), 100, null)).toBe(2 * B);
  });
  test("cuts at 90% of the byte cap", () => {
    // cap 100 -> 90: 40, 40 (=80), then 120 > 90
    expect(windowCutoff(mk([[1, 40], [1, 40], [1, 40], [1, 40]]), null, 100)).toBe(2 * B);
  });
  test("the tighter of the two caps wins", () => {
    expect(windowCutoff(mk([[10, 50], [10, 50], [10, 50]]), 1000, 100)).toBe(2 * B);
  });
  test("a newest bucket over the cap alone is still kept", () => {
    expect(windowCutoff(mk([[5, 5], [500, 5]]), 100, null)).toBe(1 * B);
  });
  test("no caps keeps everything", () => expect(windowCutoff(mk([[1e9, 1e12]]), null, null)).toBeNull());
});
