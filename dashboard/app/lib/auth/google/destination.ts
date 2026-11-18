/** Where a person lands after Google signs them in. Pure so it can be tested without a request. */
export function googleDestination(opts: { hasMembership: boolean; next: string; plan: string | null }): string {
  // An invite link is the way into an organisation, so it wins over onboarding.
  if (opts.next.startsWith("/invite/")) return opts.next;
  if (opts.hasMembership) return opts.next;
  return opts.plan ? `/onboarding?plan=${encodeURIComponent(opts.plan)}` : "/onboarding";
}
