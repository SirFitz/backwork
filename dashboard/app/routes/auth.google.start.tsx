import type { LoaderFunctionArgs } from "@remix-run/node";
import { redirect } from "@remix-run/node";
import { getUser } from "~/lib/auth/context.server";
import { googleAuthConfigured, googleAuthSettings } from "~/lib/config.server";
import { clientIp, rateLimit, safeRedirect } from "~/lib/auth/security.server";
import { buildAuthorizationUrl, newAuthRequestSecrets } from "~/lib/auth/google/oidc.server";
import { commitStateCookie } from "~/lib/auth/google/state-cookie.server";
import { GoogleErrorCode, parseGoogleIntent, GoogleIntent } from "~/lib/auth/google/types";
import { isPaidPlanId } from "~/lib/billing/rules";

/** Step one of "Continue with Google": remember state, nonce and PKCE in a signed cookie, then go to Google. */
export async function loader({ request }: LoaderFunctionArgs) {
  if (!googleAuthConfigured()) throw new Response("Not found", { status: 404 });
  if (await getUser(request)) throw redirect("/");

  const url = new URL(request.url);
  const intent = parseGoogleIntent(url.searchParams.get("intent"));
  const back = intent === GoogleIntent.SignUp ? "/register" : "/login";
  if (!rateLimit(`google:start:${clientIp(request)}`, 30, 10 * 60 * 1000).ok) {
    throw redirect(`${back}?google=${GoogleErrorCode.RateLimited}`);
  }

  const next = safeRedirect(url.searchParams.get("next"));
  const planParam = url.searchParams.get("plan");
  const plan = isPaidPlanId(planParam) ? planParam : null;
  const secrets = newAuthRequestSecrets();
  const cookie = await commitStateCookie({ ...secrets, intent, next, plan });
  return redirect(buildAuthorizationUrl(googleAuthSettings(), secrets), { headers: { "Set-Cookie": cookie } });
}
