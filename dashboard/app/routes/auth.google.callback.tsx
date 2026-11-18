import type { LoaderFunctionArgs } from "@remix-run/node";
import { redirect } from "@remix-run/node";
import { getUser } from "~/lib/auth/context.server";
import { logAudit } from "~/lib/audit.server";
import { ensureSchema } from "~/db/index.server";
import { googleAuthConfigured, googleAuthSettings } from "~/lib/config.server";
import { clientIp, rateLimit } from "~/lib/auth/security.server";
import { createUserSession } from "~/lib/auth/session.server";
import { completeAuthorization } from "~/lib/auth/google/oidc.server";
import { safeEqual } from "~/lib/auth/google/token.server";
import { clearStateCookie, readStateCookie, type GoogleStatePayload } from "~/lib/auth/google/state-cookie.server";
import { assertGoogleAuthoritative, drizzleGoogleStore, inviteEmail, recordGoogleSignIn, resolveGoogleUser } from "~/lib/auth/google/accounts.server";
import { googleDestination, inviteTokenFromPath } from "~/lib/auth/google/destination";
import { GoogleAuthError, GoogleErrorCode, GoogleIntent } from "~/lib/auth/google/types";

/** Back to the page they started on, with one plain message and the state cookie cleared. */
async function failure(code: GoogleErrorCode, saved: GoogleStatePayload | null): Promise<Response> {
  const q = new URLSearchParams({ google: code });
  let page = "/login";
  if (saved && inviteTokenFromPath(saved.next)) {
    page = saved.next; // an invitee goes back to their invite, not to the general pages
  } else if (saved?.intent === GoogleIntent.SignUp) {
    page = "/register";
    if (saved.plan) q.set("plan", saved.plan);
  }
  if (saved && page !== saved.next && saved.next !== "/") q.set("next", saved.next);
  const sep = page.includes("?") ? "&" : "?";
  return redirect(`${page}${sep}${q.toString()}`, { headers: { "Set-Cookie": await clearStateCookie() } });
}

/** Step two: Google sends the person back here with a one-time code. Trust nothing until state matches. */
export async function loader({ request }: LoaderFunctionArgs) {
  if (!googleAuthConfigured()) throw new Response("Not found", { status: 404 });

  const params = new URL(request.url).searchParams;
  const saved = await readStateCookie(request);

  if (!rateLimit(`google:callback:${clientIp(request)}`, 30, 10 * 60 * 1000).ok) return failure(GoogleErrorCode.RateLimited, saved);
  const returnedState = params.get("state") ?? "";
  if (!saved || !returnedState || !safeEqual(returnedState, saved.state)) return failure(GoogleErrorCode.StateMismatch, saved);
  if (params.get("error")) return failure(GoogleErrorCode.Cancelled, saved);
  const code = params.get("code");
  if (!code) return failure(GoogleErrorCode.ExchangeFailed, saved);

  try {
    const identity = await completeAuthorization(googleAuthSettings(), { code, verifier: saved.verifier, nonce: saved.nonce }, fetch);
    assertGoogleAuthoritative(identity); // refuse custom domains without hd before any database work
    await ensureSchema();
    // Someone already signed in who finishes a Google trip is simply sent on.
    if (await getUser(request)) return redirect(saved.next, { headers: { "Set-Cookie": await clearStateCookie() } });

    // An invite is for one address. A different Google account must not leave a stray account behind.
    const inviteToken = inviteTokenFromPath(saved.next);
    if (inviteToken) {
      const invited = await inviteEmail(inviteToken);
      if (invited && invited !== identity.email) return failure(GoogleErrorCode.InviteMismatch, saved);
    }

    const { user, created, linked } = await resolveGoogleUser(drizzleGoogleStore, identity);
    const orgId = await recordGoogleSignIn(user.id);
    void logAudit({ request, orgId, actorUserId: user.id, action: "auth.login", target: { method: "google", created, linked } });
    const response = await createUserSession(user.id, orgId, googleDestination({ hasMembership: !!orgId, next: saved.next, plan: saved.plan }), user.tokenVersion);
    response.headers.append("Set-Cookie", await clearStateCookie());
    return response;
  } catch (e) {
    if (e instanceof GoogleAuthError) return failure(e.code, saved);
    console.error("google sign-in failed", e instanceof Error ? e.message : e);
    return failure(GoogleErrorCode.ExchangeFailed, saved);
  }
}
