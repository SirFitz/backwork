import { describe, expect, test } from "bun:test";
import { cachedStale } from "./cache.server";

let n = 0;
const key = (): string => `test:stale:${++n}`;

/** A compute whose result the test releases by hand. */
function gate<T>(): { fn: () => Promise<T>; calls: () => number; resolve: (v: T) => void; reject: (e: Error) => void } {
  let calls = 0;
  let pending: { resolve: (v: T) => void; reject: (e: Error) => void } | null = null;
  return {
    fn: () => {
      calls++;
      return new Promise<T>((resolve, reject) => { pending = { resolve, reject }; });
    },
    calls: () => calls,
    resolve: (v) => pending?.resolve(v),
    reject: (e) => pending?.reject(e),
  };
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe("cachedStale", () => {
  test("the first call awaits the compute", async () => {
    const k = key();
    const clock = 1000;
    const g = gate<number>();
    const p = cachedStale(k, 100, 1000, g.fn, () => clock);
    let settled = false;
    void p.then(() => { settled = true; });
    await tick();
    expect(settled).toBe(false);
    g.resolve(7);
    expect(await p).toBe(7);
    expect(g.calls()).toBe(1);
  });

  test("a fresh value is returned without computing", async () => {
    const k = key();
    let clock = 1000;
    let calls = 0;
    const fn = async (): Promise<number> => ++calls;
    expect(await cachedStale(k, 100, 1000, fn, () => clock)).toBe(1);
    clock += 50;
    expect(await cachedStale(k, 100, 1000, fn, () => clock)).toBe(1);
    expect(calls).toBe(1);
  });

  test("a stale value is served at once while one refresh runs", async () => {
    const k = key();
    let clock = 1000;
    expect(await cachedStale(k, 100, 1000, async () => "old", () => clock)).toBe("old");
    clock += 500;
    const g = gate<string>();
    expect(await cachedStale(k, 100, 1000, g.fn, () => clock)).toBe("old");
    expect(await cachedStale(k, 100, 1000, g.fn, () => clock)).toBe("old");
    expect(g.calls()).toBe(1);
    g.resolve("new");
    await tick();
    expect(await cachedStale(k, 100, 1000, g.fn, () => clock)).toBe("new");
    expect(g.calls()).toBe(1);
  });

  test("concurrent first callers share one compute", async () => {
    const k = key();
    const g = gate<number>();
    const a = cachedStale(k, 100, 1000, g.fn);
    const b = cachedStale(k, 100, 1000, g.fn);
    g.resolve(3);
    expect(await Promise.all([a, b])).toEqual([3, 3]);
    expect(g.calls()).toBe(1);
  });

  test("a rejection is never stored", async () => {
    const k = key();
    const g = gate<number>();
    const first = cachedStale(k, 100, 1000, g.fn);
    g.reject(new Error("loki down"));
    await expect(first).rejects.toThrow("loki down");
    expect(await cachedStale(k, 100, 1000, async () => 9)).toBe(9);
  });

  test("a failed refresh keeps the stale value and retries next time", async () => {
    const k = key();
    let clock = 1000;
    await cachedStale(k, 100, 1000, async () => "old", () => clock);
    clock += 500;
    const g = gate<string>();
    expect(await cachedStale(k, 100, 1000, g.fn, () => clock)).toBe("old");
    g.reject(new Error("timeout"));
    await tick();
    let calls = 0;
    expect(await cachedStale(k, 100, 1000, async () => { calls++; return "new"; }, () => clock)).toBe("old");
    await tick();
    expect(calls).toBe(1);
    expect(await cachedStale(k, 100, 1000, async () => "unused", () => clock)).toBe("new");
  });

  test("a value past maxStaleMs is not served: the caller waits", async () => {
    const k = key();
    let clock = 1000;
    await cachedStale(k, 100, 1000, async () => "ancient", () => clock);
    clock += 5000;
    expect(await cachedStale(k, 100, 1000, async () => "current", () => clock)).toBe("current");
  });
});
