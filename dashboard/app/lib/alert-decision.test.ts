import { describe, expect, test } from "bun:test";
import { AlertNotify, ObservationKind, RuleStatus, decide, ruleStatus, stateChanged, type AlertStateRow } from "./alert-decision";

const breach = { kind: ObservationKind.Breach };
const ok = { kind: ObservationKind.Ok };
const nodata = { kind: ObservationKind.NoData };
const MIN = 60_000;
const FOR = 5 * MIN;
const T0 = 1_000_000;

/** Feed observations one minute apart; collect the notifications. */
function run(obs: Array<{ kind: ObservationKind }>, forMs: number, start: AlertStateRow | null = null): { notes: Array<AlertNotify | null>; last: AlertStateRow } {
  let prev = start;
  const notes: Array<AlertNotify | null> = [];
  obs.forEach((o, i) => {
    const d = decide(prev, o, T0 + i * MIN, forMs);
    notes.push(d.notify);
    prev = d.next;
  });
  return { notes, last: prev ?? { firing: false, pendingSince: null } };
}

describe("decide", () => {
  test("a breach shorter than the pending period does not fire", () => {
    const { notes, last } = run([breach, breach, breach, ok], FOR);
    expect(notes).toEqual([null, null, null, null]);
    expect(last).toEqual({ firing: false, pendingSince: null });
  });
  test("a breach held for the pending period fires once; later breaches do not notify again", () => {
    const { notes } = run([breach, breach, breach, breach, breach, breach, breach, breach], FOR);
    expect(notes).toEqual([null, null, null, null, null, AlertNotify.Firing, null, null]);
  });
  test("ok resolves once", () => {
    const { notes } = run([breach, ok, ok], 0);
    expect(notes).toEqual([AlertNotify.Firing, AlertNotify.Resolved, null]);
  });
  test("no data keeps the state, pending time included", () => {
    const pending = decide(null, breach, T0, FOR).next;
    expect(decide(pending, nodata, T0 + 10 * MIN, FOR)).toEqual({ next: pending, notify: null });
    const firing = { firing: true, pendingSince: null };
    expect(decide(firing, nodata, T0, FOR)).toEqual({ next: firing, notify: null });
    // and a breach after the gap fires, since the pending time was kept
    expect(decide(pending, breach, T0 + FOR, FOR).notify).toBe(AlertNotify.Firing);
  });
  test("a pending period of 0 fires at once", () => {
    expect(decide(null, breach, T0, 0)).toEqual({ next: { firing: true, pendingSince: null }, notify: AlertNotify.Firing });
  });
  test("an ok clears the pending time, so the wait starts again", () => {
    const { notes } = run([breach, breach, ok, breach, breach, breach, breach, breach, breach], FOR);
    expect(notes.indexOf(AlertNotify.Firing)).toBe(8);
  });
  test("a restart that loads a firing state does not notify again", () => {
    const loaded: AlertStateRow = { firing: true, pendingSince: null };
    expect(decide(loaded, breach, T0, FOR).notify).toBeNull();
    expect(decide(loaded, ok, T0, FOR).notify).toBe(AlertNotify.Resolved);
  });
  test("a restart that loads a pending state keeps its start", () => {
    const loaded: AlertStateRow = { firing: false, pendingSince: T0 - 4 * MIN };
    expect(decide(loaded, breach, T0, FOR).notify).toBeNull();
    expect(decide(loaded, breach, T0 + MIN, FOR).notify).toBe(AlertNotify.Firing);
  });
  test("stateChanged notices pending and firing changes only", () => {
    expect(stateChanged(null, { firing: false, pendingSince: null })).toBe(false);
    expect(stateChanged(null, { firing: false, pendingSince: T0 })).toBe(true);
    expect(stateChanged({ firing: false, pendingSince: T0 }, { firing: false, pendingSince: T0 })).toBe(false);
  });
});

describe("ruleStatus", () => {
  const base = { retired: false, enabled: true, noData: false, breach: false, stored: null, forMs: FOR };
  test("stored firing wins; a waiting breach is pending; a rule without a wait shows firing", () => {
    expect(ruleStatus({ ...base, stored: { firing: true, pendingSince: null } })).toBe(RuleStatus.Firing);
    expect(ruleStatus({ ...base, breach: true })).toBe(RuleStatus.Pending);
    expect(ruleStatus({ ...base, breach: true, forMs: 0 })).toBe(RuleStatus.Firing);
    expect(ruleStatus(base)).toBe(RuleStatus.Ok);
  });
  test("retired, disabled and no data", () => {
    expect(ruleStatus({ ...base, retired: true, enabled: false })).toBe(RuleStatus.Retired);
    expect(ruleStatus({ ...base, enabled: false })).toBe(RuleStatus.Disabled);
    expect(ruleStatus({ ...base, noData: true })).toBe(RuleStatus.NoData);
    expect(ruleStatus({ ...base, noData: true, stored: { firing: false, pendingSince: T0 } })).toBe(RuleStatus.Pending);
  });
});
