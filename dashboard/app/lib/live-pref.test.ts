import { describe, expect, test } from "bun:test";
import { LIVE_PAUSED_KEY, readLivePaused, writeLivePaused, type PrefStorage } from "./live-pref";

function memory(): PrefStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
  };
}

const blocked: PrefStorage = {
  getItem: () => { throw new Error("blocked"); },
  setItem: () => { throw new Error("blocked"); },
};

describe("live pref", () => {
  test("defaults to live when nothing is saved", () => {
    expect(readLivePaused(memory())).toBe(false);
  });

  test("pause survives a reload, resume clears it", () => {
    const s = memory();
    writeLivePaused(true, s);
    expect(s.data.get(LIVE_PAUSED_KEY)).toBe("1");
    expect(readLivePaused(s)).toBe(true);
    writeLivePaused(false, s);
    expect(readLivePaused(s)).toBe(false);
  });

  test("blocked or missing storage never throws and reads as live", () => {
    expect(readLivePaused(blocked)).toBe(false);
    expect(() => writeLivePaused(true, blocked)).not.toThrow();
    expect(readLivePaused(null)).toBe(false);
    expect(() => writeLivePaused(true, null)).not.toThrow();
  });
});
