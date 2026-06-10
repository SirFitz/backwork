import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json, redirect } from "@remix-run/node";
import { Form, Link, useActionData, useLoaderData, useNavigation } from "@remix-run/react";
import { and, eq, gt, isNull } from "drizzle-orm";
import { db, ensureSchema } from "~/db/index.server";
import { users, passwordResets } from "~/db/schema";
import { hashPassword, passwordError } from "~/lib/auth/password.server";
import { assertSameOrigin } from "~/lib/auth/security.server";
import { hashToken } from "~/lib/tenant.server";
import { AuthCard, AUTH_FIELD } from "~/components/authcard";

async function validToken(token: string) {
  await ensureSchema();
  const rows = await db
    .select()
    .from(passwordResets)
    .where(and(eq(passwordResets.tokenHash, hashToken(token)), isNull(passwordResets.usedAt), gt(passwordResets.expiresAt, new Date())))
    .limit(1);
  return rows[0] ?? null;
}

export async function loader({ params }: LoaderFunctionArgs) {
  const valid = !!(await validToken(params.token!));
  return json({ valid });
}

export async function action({ request, params }: ActionFunctionArgs) {
  assertSameOrigin(request);
  const row = await validToken(params.token!);
  if (!row) return json({ error: "This reset link is invalid or has expired." }, { status: 400 });
  const fd = await request.formData();
  const next = String(fd.get("next") || "");
  const confirm = String(fd.get("confirm") || "");
  const pwErr = passwordError(next);
  if (pwErr) return json({ error: pwErr }, { status: 400 });
  if (next !== confirm) return json({ error: "Passwords don't match." }, { status: 400 });
  // set new password, invalidate all existing sessions, consume the token
  await db.update(users).set({ passwordHash: await hashPassword(next), tokenVersion: ((await db.select({ tv: users.tokenVersion }).from(users).where(eq(users.id, row.userId)).limit(1))[0]?.tv ?? 0) + 1, updatedAt: new Date() }).where(eq(users.id, row.userId));
  await db.update(passwordResets).set({ usedAt: new Date() }).where(eq(passwordResets.id, row.id));
  return redirect("/login?reset=1");
}

export default function ResetPassword() {
  const d = useLoaderData<typeof loader>();
  const data = useActionData<typeof action>();
  const nav = useNavigation();
  if (!d.valid) {
    return (
      <AuthCard title="Link expired" sub="This reset link is invalid, already used, or expired." footer={<Link to="/forgot" className="font-medium text-brand hover:underline">Request a new link</Link>}>
        <div />
      </AuthCard>
    );
  }
  return (
    <AuthCard title="Set a new password" sub="Choose a new password for your account.">
      <Form method="post" className="space-y-3">
        <input name="next" type="password" autoComplete="new-password" required placeholder="New password (10+ chars, a letter & a number)" className={AUTH_FIELD} autoFocus />
        <input name="confirm" type="password" autoComplete="new-password" required placeholder="Confirm new password" className={AUTH_FIELD} />
        {data?.error ? <p className="text-[13px] text-err">{data.error}</p> : null}
        <button type="submit" disabled={nav.state !== "idle"} className="h-10 w-full rounded-lg bg-brand text-[14px] font-medium text-brand-fg hover:opacity-90 disabled:opacity-60">
          {nav.state !== "idle" ? "Saving…" : "Set password"}
        </button>
      </Form>
    </AuthCard>
  );
}
