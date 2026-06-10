import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { Form, useActionData, useLoaderData, useNavigation } from "@remix-run/react";
import { eq } from "drizzle-orm";
import { KeyRound, Save } from "lucide-react";
import { Card, CardHead, PageTitle } from "~/components/ui";
import { db } from "~/db/index.server";
import { users } from "~/db/schema";
import { requireUser } from "~/lib/auth/context.server";
import { hashPassword, verifyPassword, passwordError } from "~/lib/auth/password.server";
import { reissueTokenVersion } from "~/lib/auth/session.server";
import { assertSameOrigin } from "~/lib/auth/security.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const { user } = await requireUser(request);
  return json({ name: user.name, email: user.email });
}

export async function action({ request }: ActionFunctionArgs) {
  assertSameOrigin(request);
  const { user } = await requireUser(request);
  const fd = await request.formData();
  const intent = String(fd.get("intent"));

  if (intent === "profile") {
    const name = String(fd.get("name") || "").trim();
    await db.update(users).set({ name, updatedAt: new Date() }).where(eq(users.id, user.id));
    return json({ ok: "Profile updated.", scope: "profile" });
  }

  if (intent === "password") {
    const current = String(fd.get("current") || "");
    const next = String(fd.get("next") || "");
    const confirm = String(fd.get("confirm") || "");
    if (!(await verifyPassword(user.passwordHash, current))) return json({ error: "Current password is incorrect.", scope: "password" }, { status: 400 });
    const pwErr = passwordError(next);
    if (pwErr) return json({ error: pwErr, scope: "password" }, { status: 400 });
    if (next !== confirm) return json({ error: "New passwords don't match.", scope: "password" }, { status: 400 });
    if (next === current) return json({ error: "New password must be different from the current one.", scope: "password" }, { status: 400 });
    const newVersion = user.tokenVersion + 1; // invalidate other devices' sessions
    await db.update(users).set({ passwordHash: await hashPassword(next), tokenVersion: newVersion, updatedAt: new Date() }).where(eq(users.id, user.id));
    return json({ ok: "Password changed. Other devices have been signed out.", scope: "password" }, { headers: { "Set-Cookie": await reissueTokenVersion(request, newVersion) } });
  }

  return json({ error: "Unknown action.", scope: "" }, { status: 400 });
}

const FIELD = "h-9 w-full rounded-lg border border-border bg-surface px-3 text-[13px] outline-none focus:border-brand/40";

export default function Account() {
  const d = useLoaderData<typeof loader>();
  const data = useActionData<typeof action>();
  const nav = useNavigation();
  const busy = nav.state !== "idle";
  const msg = (scope: string) =>
    data?.scope === scope ? (
      "ok" in data && data.ok ? <p className="text-[13px] text-ok">{data.ok}</p> : "error" in data && data.error ? <p className="text-[13px] text-err">{data.error}</p> : null
    ) : null;

  return (
    <div className="max-w-xl space-y-5 animate-fade-in">
      <PageTitle title="Account" sub="Your profile and password." />

      <Card>
        <CardHead title="Profile" sub="how you appear to your team" />
        <Form method="post" className="space-y-3 p-4">
          <input type="hidden" name="intent" value="profile" />
          <label className="block text-2xs font-medium text-muted">Name<input name="name" defaultValue={d.name} className={`${FIELD} mt-1`} /></label>
          <label className="block text-2xs font-medium text-muted">Email<input value={d.email} disabled className={`${FIELD} mt-1 text-faint`} /></label>
          {msg("profile")}
          <button type="submit" disabled={busy} className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-border px-3 text-[13px] font-medium hover:bg-surface-2 disabled:opacity-60"><Save className="h-4 w-4" /> Save profile</button>
        </Form>
      </Card>

      <Card>
        <CardHead title="Change password" sub="you'll stay signed in on this device" />
        <Form method="post" className="space-y-3 p-4" key={data?.scope === "password" && "ok" in data ? "reset" : "form"}>
          <input type="hidden" name="intent" value="password" />
          <input name="current" type="password" autoComplete="current-password" required placeholder="Current password" className={FIELD} />
          <input name="next" type="password" autoComplete="new-password" required placeholder="New password (10+ chars, a letter & a number)" className={FIELD} />
          <input name="confirm" type="password" autoComplete="new-password" required placeholder="Confirm new password" className={FIELD} />
          {msg("password")}
          <button type="submit" disabled={busy} className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-brand px-3 text-[13px] font-medium text-brand-fg hover:opacity-90 disabled:opacity-60"><KeyRound className="h-4 w-4" /> {busy ? "Saving…" : "Change password"}</button>
        </Form>
      </Card>
    </div>
  );
}
