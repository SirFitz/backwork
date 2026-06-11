import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json, redirect } from "@remix-run/node";
import { Form, Link, useActionData, useNavigation } from "@remix-run/react";
import { sql } from "drizzle-orm";
import { ulid } from "ulid";
import { db, ensureSchema } from "~/db/index.server";
import { users } from "~/db/schema";
import { hashPassword, passwordError } from "~/lib/auth/password.server";
import { createUserSession } from "~/lib/auth/session.server";
import { getUser } from "~/lib/auth/context.server";
import { assertSameOrigin, clientIp, rateLimit } from "~/lib/auth/security.server";
import { AuthCard, AUTH_FIELD } from "~/components/authcard";

export async function loader({ request }: LoaderFunctionArgs) {
  if (await getUser(request)) throw redirect("/");
  return json({});
}

export async function action({ request }: ActionFunctionArgs) {
  assertSameOrigin(request);
  if (await getUser(request)) throw redirect("/"); // guard the action, not just the loader (login-CSRF / session swap)
  await ensureSchema();
  const ip = clientIp(request);
  if (!rateLimit(`register:ip:${ip}`, 10, 60 * 60 * 1000).ok) return json({ error: "Too many sign-ups from this network. Please try again later." }, { status: 429 });
  const fd = await request.formData();
  const name = String(fd.get("name") || "").trim();
  const email = String(fd.get("email") || "").trim().toLowerCase();
  const password = String(fd.get("password") || "");
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json({ error: "Enter a valid email address." }, { status: 400 });
  const pwErr = passwordError(password);
  if (pwErr) return json({ error: pwErr }, { status: 400 });

  const existing = await db.select({ id: users.id }).from(users).where(sql`lower(${users.email}) = ${email}`).limit(1);
  if (existing.length) return json({ error: "An account with that email already exists." }, { status: 400 });

  const anyUser = await db.select({ id: users.id }).from(users).limit(1);
  const id = ulid();
  await db.insert(users).values({
    id,
    email,
    name,
    passwordHash: await hashPassword(password),
    isPlatformAdmin: anyUser.length === 0, // first user bootstraps as platform admin
    emailVerifiedAt: new Date(),
  });
  return createUserSession(id, null, "/onboarding", 0);
}

export default function Register() {
  const data = useActionData<typeof action>();
  const nav = useNavigation();
  return (
    <AuthCard title="Create your account" sub="Start monitoring in minutes." footer={<>Already have an account? <Link to="/login" className="font-medium text-brand hover:underline">Sign in</Link></>}>
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
