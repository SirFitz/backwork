import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json, redirect } from "@remix-run/node";
import { Form, Link, useActionData, useNavigation, useSearchParams } from "@remix-run/react";
import { eq } from "drizzle-orm";
import { db, ensureSchema } from "~/db/index.server";
import { users, memberships } from "~/db/schema";
import { verifyPassword } from "~/lib/auth/password.server";
import { createUserSession } from "~/lib/auth/session.server";
import { getUser } from "~/lib/auth/context.server";
import { assertSameOrigin, clientIp, rateLimit, safeRedirect } from "~/lib/auth/security.server";
import { AuthCard, AUTH_FIELD } from "~/components/authcard";

export async function loader({ request }: LoaderFunctionArgs) {
  if (await getUser(request)) throw redirect("/");
  return json({});
}

export async function action({ request }: ActionFunctionArgs) {
  assertSameOrigin(request);
  await ensureSchema();
  const fd = await request.formData();
  const email = String(fd.get("email") || "").trim().toLowerCase();
  const password = String(fd.get("password") || "");
  const next = safeRedirect(fd.get("next"));
  if (!email || !password) return json({ error: "Email and password are required." }, { status: 400 });

  const ip = clientIp(request);
  const limited = !rateLimit(`login:ip:${ip}`, 20, 10 * 60 * 1000).ok || !rateLimit(`login:email:${email}`, 8, 10 * 60 * 1000).ok;
  if (limited) return json({ error: "Too many attempts. Please wait a few minutes and try again." }, { status: 429 });

  const rows = await db.select().from(users).where(eq(users.email, email)).limit(1);
  const user = rows[0];
  const ok = user ? await verifyPassword(user.passwordHash, password) : false;
  if (!user || !ok) return json({ error: "Invalid email or password." }, { status: 400 });

  await db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, user.id));
  const mem = await db.select({ orgId: memberships.orgId }).from(memberships).where(eq(memberships.userId, user.id)).limit(1);
  return createUserSession(user.id, mem[0]?.orgId ?? null, mem.length ? next : "/onboarding", user.tokenVersion);
}

export default function Login() {
  const data = useActionData<typeof action>();
  const nav = useNavigation();
  const [params] = useSearchParams();
  const next = params.get("next") || "/";
  const justReset = params.get("reset") === "1";
  return (
    <AuthCard title="Sign in" sub="Welcome back to backwork." footer={<>No account? <Link to="/register" className="font-medium text-brand hover:underline">Create one</Link></>}>
      <Form method="post" className="space-y-3">
        <input type="hidden" name="next" value={next} />
        <input name="email" type="email" autoComplete="email" required placeholder="you@example.com" aria-label="Email address" className={AUTH_FIELD} />
        <input name="password" type="password" autoComplete="current-password" required placeholder="Password" aria-label="Password" className={AUTH_FIELD} />
        {justReset ? <p className="text-[13px] text-ok">Password updated — sign in with your new password.</p> : null}
        <div className="text-right"><Link to="/forgot" className="text-2xs text-muted hover:text-brand hover:underline">Forgot password?</Link></div>
        {data?.error ? <p className="text-[13px] text-err">{data.error}</p> : null}
        <button type="submit" disabled={nav.state !== "idle"} className="h-10 w-full rounded-lg bg-brand text-[14px] font-medium text-brand-fg hover:opacity-90 disabled:opacity-60">
          {nav.state !== "idle" ? "Signing in…" : "Sign in"}
        </button>
      </Form>
    </AuthCard>
  );
}
