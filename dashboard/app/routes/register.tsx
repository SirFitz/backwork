import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json, redirect } from "@remix-run/node";
import { Form, Link, useActionData, useLoaderData, useNavigation, useSearchParams } from "@remix-run/react";
import { sql } from "drizzle-orm";
import { ulid } from "ulid";
import { db, ensureSchema } from "~/db/index.server";
import { users } from "~/db/schema";
import { insertUserFirstAdmin } from "~/lib/auth/users.server";
import { hashPassword, passwordError } from "~/lib/auth/password.server";
import { createUserSession } from "~/lib/auth/session.server";
import { getUser } from "~/lib/auth/context.server";
import { assertSameOrigin, clientIp, rateLimit, safeRedirect } from "~/lib/auth/security.server";
import { AuthCard, AUTH_FIELD } from "~/components/authcard";
import { GoogleButton } from "~/components/google-button";
import { googleAuthConfigured } from "~/lib/config.server";
import { GoogleIntent, googleErrorMessage } from "~/lib/auth/google/types";
import { isPaidPlanId } from "~/lib/billing/rules";
import type { PaidPlanId } from "~/lib/billing/types";
import { trackServer } from "~/lib/analytics/server.server";
import { AuthMethod, LoginFailure, ServerEvent, SignupFailure } from "~/lib/analytics/events";

/** The plan a pricing-page button asked for (?plan=team), if it is one we sell. */
function wantedPlan(request: Request): PaidPlanId | null {
  const plan = new URL(request.url).searchParams.get("plan");
  return isPaidPlanId(plan) ? plan : null;
}

export async function loader({ request }: LoaderFunctionArgs) {
  if (await getUser(request)) throw redirect("/");
  return json({ plan: wantedPlan(request), next: safeRedirect(new URL(request.url).searchParams.get("next")), googleEnabled: googleAuthConfigured() });
}

export async function action({ request }: ActionFunctionArgs) {
  assertSameOrigin(request);
  if (await getUser(request)) throw redirect("/"); // guard the action, not just the loader (login-CSRF / session swap)
  await ensureSchema();
  const ip = clientIp(request);
  if (!rateLimit(`register:ip:${ip}`, 10, 60 * 60 * 1000).ok) {
    trackServer(ServerEvent.SignupFailed, { method: AuthMethod.Email, reason: SignupFailure.RateLimited });
    return json({ error: "Too many sign-ups from this network. Please try again later." }, { status: 429 });
  }
  const fd = await request.formData();
  const name = String(fd.get("name") || "").trim();
  const email = String(fd.get("email") || "").trim().toLowerCase();
  const password = String(fd.get("password") || "");
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    trackServer(ServerEvent.SignupFailed, { method: AuthMethod.Email, reason: SignupFailure.InvalidEmail });
    return json({ error: "Enter a valid email address." }, { status: 400 });
  }
  const pwErr = passwordError(password);
  if (pwErr) {
    trackServer(ServerEvent.SignupFailed, { method: AuthMethod.Email, reason: SignupFailure.WeakPassword });
    return json({ error: pwErr }, { status: 400 });
  }

  const existing = await db.select({ id: users.id }).from(users).where(sql`lower(${users.email}) = ${email}`).limit(1);
  if (existing.length) {
    trackServer(ServerEvent.SignupFailed, { method: AuthMethod.Email, reason: SignupFailure.EmailTaken });
    return json({ error: "An account with that email already exists." }, { status: 400 });
  }

  const id = ulid();
  // first user ever bootstraps as platform admin (decided under a lock in insertUserFirstAdmin)
  await insertUserFirstAdmin({ id, email, name, passwordHash: await hashPassword(password), emailVerifiedAt: new Date() }, { id: users.id });
  const plan = wantedPlan(request);
  trackServer(ServerEvent.SignupCompleted, { method: AuthMethod.Email, plan_requested: plan !== null });
  return createUserSession(id, null, plan ? `/onboarding?plan=${plan}` : "/onboarding", 0);
}

export default function Register() {
  const data = useActionData<typeof action>();
  const { plan, next, googleEnabled } = useLoaderData<typeof loader>();
  const nav = useNavigation();
  const [params] = useSearchParams();
  const googleError = googleErrorMessage(params.get("google"));
  return (
    <AuthCard title="Create your account" sub="Start monitoring in minutes." footer={<>Already have an account? <Link to="/login" className="font-medium text-brand hover:underline">Sign in</Link></>}>
      {googleEnabled ? <GoogleButton intent={GoogleIntent.SignUp} plan={plan} next={next} /> : null}
      {googleEnabled && googleError ? <p className="-mt-2 mb-4 text-[13px] text-err">{googleError}</p> : null}
      <Form method="post" className="space-y-3">
        <input name="name" type="text" autoComplete="name" placeholder="Your name" aria-label="Your name" className={AUTH_FIELD} />
        <input name="email" type="email" autoComplete="email" required placeholder="you@example.com" aria-label="Email address" className={AUTH_FIELD} />
        <input name="password" type="password" autoComplete="new-password" required placeholder="Password (10+ chars)" aria-label="Password" className={AUTH_FIELD} />
        {data?.error ? <p className="text-[13px] text-err">{data.error}</p> : null}
        <button type="submit" disabled={nav.state !== "idle"} className="h-10 w-full rounded-lg bg-brand text-[14px] font-medium text-brand-fg hover:opacity-90 disabled:opacity-60">
          {nav.state !== "idle" ? "Creating…" : "Create account"}
        </button>
      </Form>
    </AuthCard>
  );
}
