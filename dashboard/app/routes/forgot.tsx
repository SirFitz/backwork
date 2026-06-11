import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json, redirect } from "@remix-run/node";
import { Form, Link, useActionData, useNavigation } from "@remix-run/react";
import { sql } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import { ulid } from "ulid";
import { db, ensureSchema } from "~/db/index.server";
import { users, passwordResets } from "~/db/schema";
import { getUser } from "~/lib/auth/context.server";
import { assertSameOrigin, clientIp, rateLimit } from "~/lib/auth/security.server";
import { hashToken } from "~/lib/tenant.server";
import { sendMail } from "~/lib/mailer.server";
import { config } from "~/lib/config.server";
import { AuthCard, AUTH_FIELD } from "~/components/authcard";

export async function loader({ request }: LoaderFunctionArgs) {
  if (await getUser(request)) throw redirect("/");
  return json({});
}

export async function action({ request }: ActionFunctionArgs) {
  assertSameOrigin(request);
  await ensureSchema();
  const ip = clientIp(request);
  const fd = await request.formData();
  const email = String(fd.get("email") || "").trim().toLowerCase();
  // Always return the same generic response (no account enumeration).
  const generic = json({ sent: true });
  if (!email || !rateLimit(`forgot:ip:${ip}`, 10, 60 * 60 * 1000).ok || !rateLimit(`forgot:email:${email}`, 5, 60 * 60 * 1000).ok) return generic;

  const rows = await db.select({ id: users.id }).from(users).where(sql`lower(${users.email}) = ${email}`).limit(1);
  const user = rows[0];
  if (user) {
    const token = randomBytes(32).toString("hex");
    await db.insert(passwordResets).values({
      id: ulid(),
      userId: user.id,
      tokenHash: hashToken(token),
      expiresAt: new Date(Date.now() + 30 * 60 * 1000),
    });
    const link = `${config.publicUrl}/reset/${token}`;
    await sendMail(email, "Reset your backwork password", `Someone requested a password reset for your backwork account.\n\nReset it here (valid 30 minutes):\n${link}\n\nIf this wasn't you, ignore this email.`);
  }
  return generic;
}

export default function Forgot() {
  const data = useActionData<typeof action>();
  const nav = useNavigation();
  if (data?.sent) {
    return (
      <AuthCard title="Check your email" sub="If an account exists for that address, we've sent a reset link (valid 30 minutes)." footer={<Link to="/login" className="font-medium text-brand hover:underline">Back to sign in</Link>}>
        <div />
      </AuthCard>
    );
  }
  return (
    <AuthCard title="Reset your password" sub="Enter your email and we'll send a reset link." footer={<Link to="/login" className="font-medium text-brand hover:underline">Back to sign in</Link>}>
      <Form method="post" className="space-y-3">
        <input name="email" type="email" autoComplete="email" required placeholder="you@example.com" className={AUTH_FIELD} autoFocus />
        <button type="submit" disabled={nav.state !== "idle"} className="h-10 w-full rounded-lg bg-brand text-[14px] font-medium text-brand-fg hover:opacity-90 disabled:opacity-60">
          {nav.state !== "idle" ? "Sending…" : "Send reset link"}
        </button>
      </Form>
    </AuthCard>
  );
}
