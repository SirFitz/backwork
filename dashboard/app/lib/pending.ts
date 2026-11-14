/**
 * Which control is waiting? `useNavigation()` is one global state for the whole
 * page, so a button that reads `nav.state !== "idle"` lights up every sibling
 * when any of them is pressed. A control shows its own pending state only when
 * the submission in flight carries its own fields (intent, plan, ...).
 */
export interface PendingNavigation {
  state: "idle" | "loading" | "submitting";
  formData?: FormData | undefined;
}

/**
 * A form submission is in flight: use this to disable the other controls, never to
 * relabel them. A plain page navigation (a sidebar click) is not a submission, so it
 * does not grey out the page's buttons.
 */
export function isBusy(nav: PendingNavigation): boolean {
  return nav.state !== "idle" && nav.formData !== undefined;
}

/** This control's own submission is in flight: every field in `match` equals what was submitted. */
export function isSubmittingOwn(nav: PendingNavigation, match: Record<string, string | undefined>): boolean {
  if (nav.state === "idle" || !nav.formData) return false;
  const form = nav.formData;
  return Object.entries(match).every(([name, value]) => (form.get(name)?.toString() ?? "") === (value ?? ""));
}
