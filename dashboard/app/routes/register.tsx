import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json, redirect } from "@remix-run/node";
import { Form, Link, useActionData, useNavigation } from "@remix-run/react";
import { eq } from "drizzle-orm";
import { ulid } from "ulid";
import { db, ensureSchema } from "~/db/index.server";
import { users } from "~/db/schema";
import { hashPassword, passwordError } from "~/lib/auth/password.server";
import { createUserSession } from "~/lib/auth/session.server";
import { getUser } from "~/lib/auth/context.server";
import { AuthCard, AUTH_FIELD } from "~/components/authcard";

export async function loader({ request }: LoaderFunctionArgs) {
  if (await getUser(request)) throw redirect("/");
  return json({});
}

export async function action({ request }: ActionFunctionArgs) {
  await ensureSchema();
  const fd = await request.formData();
  const name = String(fd.get("name") || "").trim();
  const email = String(fd.get("email") || "").trim().toLowerCase();
  const password = String(fd.get("password") || "");
  if (!email) return json({ error: "Email is required." }, { status: 400 });
  const pwErr = passwordError(password);
  if (pwErr) return json({ error: pwErr }, { status: 400 });

  const existing = await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
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
  return createUserSession(id, null, "/onboarding");
}

export default function Register() {
  const data = useActionData<typeof action>();
  const nav = useNavigation();
  return (
    <AuthCard title="Create your account" sub="Start monitoring in minutes." footer={<>Already have an account? <Link to="/login" className="font-medium text-brand hover:underline">Sign in</Link></>}>
      <Form method="post" className="space-y-3">
        <input name="name" type="text" autoComplete="name" placeholder="Your name" className={AUTH_FIELD} />
        <input name="email" type="email" autoComplete="email" required placeholder="you@example.com" className={AUTH_FIELD} />
        <input name="password" type="password" autoComplete="new-password" required placeholder="Password (10+ chars)" className={AUTH_FIELD} />
        {data?.error ? <p className="text-[13px] text-err">{data.error}</p> : null}
        <button type="submit" disabled={nav.state !== "idle"} className="h-10 w-full rounded-lg bg-brand text-[14px] font-medium text-brand-fg hover:opacity-90 disabled:opacity-60">
          {nav.state !== "idle" ? "Creating…" : "Create account"}
        </button>
      </Form>
    </AuthCard>
  );
}
