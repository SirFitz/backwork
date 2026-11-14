// What an alert does with one reading (BAC-72). Pure.
//
// The evaluator reads a rule, turns the reading into an observation and asks `decide` what the
// stored state becomes and whether to notify. The stored state lives in `alert_state`, so a
// restart loads it and carries on: nothing is replayed and no transition is lost.

/** One reading of a rule: over its threshold, under it, or nothing to judge (query failed, below the floor). */
export const ObservationKind = { Breach: "breach", Ok: "ok", NoData: "nodata" } as const;
export type ObservationKind = (typeof ObservationKind)[keyof typeof ObservationKind];
export interface Observation {
  kind: ObservationKind;
}

/** The stored state of one rule; `pendingSince` (epoch ms) is set while a breach waits out the pending period. */
export interface AlertStateRow {
  firing: boolean;
  pendingSince: number | null;
}

/** What a transition sends. */
export const AlertNotify = { Firing: "firing", Resolved: "resolved" } as const;
export type AlertNotify = (typeof AlertNotify)[keyof typeof AlertNotify];

export interface Decision {
  next: AlertStateRow;
  notify: AlertNotify | null;
}

const INITIAL: AlertStateRow = { firing: false, pendingSince: null };

/**
 * The next state and notification for one observation.
 * - breach: a rule not yet firing starts (or keeps) its pending time and fires once it has been
 *   breaching for `forMs`; a firing rule stays firing and does not notify again.
 * - ok: pending is cleared; a firing rule resolves (once).
 * - nodata: nothing changes.
 */
export function decide(prev: AlertStateRow | null, obs: Observation, nowMs: number, forMs: number): Decision {
  const state = prev ?? INITIAL;
  switch (obs.kind) {
    case ObservationKind.NoData:
      return { next: state, notify: null };
    case ObservationKind.Ok:
      return { next: INITIAL, notify: state.firing ? AlertNotify.Resolved : null };
    case ObservationKind.Breach: {
      if (state.firing) return { next: { firing: true, pendingSince: null }, notify: null };
      const pendingSince = state.pendingSince ?? nowMs;
      if (nowMs - pendingSince >= forMs) return { next: { firing: true, pendingSince: null }, notify: AlertNotify.Firing };
      return { next: { firing: false, pendingSince }, notify: null };
    }
  }
}

/** Whether two states differ (a pending update to store). */
export function stateChanged(a: AlertStateRow | null, b: AlertStateRow): boolean {
  const prev = a ?? INITIAL;
  return prev.firing !== b.firing || prev.pendingSince !== b.pendingSince;
}

/** The status a rule shows on the page. */
export const RuleStatus = {
  Retired: "retired",
  Disabled: "disabled",
  NoData: "no_data",
  Firing: "firing",
  Pending: "pending",
  Ok: "ok",
} as const;
export type RuleStatus = (typeof RuleStatus)[keyof typeof RuleStatus];

export interface StatusInput {
  retired: boolean;
  enabled: boolean;
  noData: boolean;
  /** The live reading is over the threshold. */
  breach: boolean;
  /** The stored state, or null before the evaluator has seen the rule. */
  stored: AlertStateRow | null;
  forMs: number;
}

/**
 * The page status: the stored state decides firing (it is what was sent); a live breach that has
 * not fired yet is pending when the rule waits, firing when it does not (the next check sends it).
 */
export function ruleStatus(s: StatusInput): RuleStatus {
  if (s.retired) return RuleStatus.Retired;
  if (!s.enabled) return RuleStatus.Disabled;
  if (s.stored?.firing) return RuleStatus.Firing;
  if (s.noData) return s.stored?.pendingSince != null ? RuleStatus.Pending : RuleStatus.NoData;
  if (!s.breach) return RuleStatus.Ok;
  return s.forMs > 0 ? RuleStatus.Pending : RuleStatus.Firing;
}
