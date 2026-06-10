import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { Form, Link, useActionData, useLoaderData } from "@remix-run/react";
import { and, eq } from "drizzle-orm";
import { ulid } from "ulid";
import { db, ensureSchema } from "~/db/index.server";
import { invitations, memberships, orgs } from "~/db/schema";
import { getUser, requireUser } from "~/lib/auth/context.server";
import { setActiveOrg } from "~/lib/auth/session.server";
import { assertSameOrigin } from "~/lib/auth/security.server";
import { AuthCard } from "~/components/authcard";

export async function loader({ request, params }: LoaderFunctionArgs) {
  await ensureSchema();
  const token = params.token!;
  const inv = await db.select().from(invitations).where(eq(invitations.token, token)).limit(1);
  const invite = inv[0];
  const valid = !!invite && !invite.acceptedAt && new Date(invite.expiresAt) > new Date();
  const user = await getUser(request);
  let orgName = "";
  if (invite) {
    const o = await db.select({ name: orgs.name }).from(orgs).where(eq(orgs.id, invite.orgId)).limit(1);
    orgName = o[0]?.name || "";
  }
  return json({
    valid,
    token,
    orgName,
    email: invite?.email ?? null,
    role: invite?.role ?? null,
    loggedIn: !!user,
    myEmail: user?.email ?? null,
    emailMatches: !!user && user.email === invite?.email,
  });
}

export async function action({ request, params }: ActionFunctionArgs) {
  assertSameOrigin(request);
  const { user } = await requireUser(request);
  const token = params.token!;
  const inv = await db.select().from(invitations).where(eq(invitations.token, token)).limit(1);
  const invite = inv[0];
  if (!invite || invite.acceptedAt || new Date(invite.expiresAt) < new Date()) return json({ error: "This invite is no longer valid." }, { status: 400 });
  if (user.email !== invite.email) return json({ error: `This invite is for ${invite.email}.` }, { status: 400 });
  const dup = await db.select({ id: memberships.id }).from(memberships).where(and(eq(memberships.userId, user.id), eq(memberships.orgId, invite.orgId))).limit(1);
  if (!dup.length) await db.insert(memberships).values({ id: ulid(), userId: user.id, orgId: invite.orgId, role: invite.role });
  await db.update(invitations).set({ acceptedAt: new Date() }).where(eq(invitations.id, invite.id));
  return setActiveOrg(request, invite.orgId, "/");
}

export default function AcceptInvite() {
  const d = useLoaderData<typeof loader>();
  const data = useActionData<typeof action>();

  if (!d.valid) {
    return <AuthCard title="Invitation not found" sub="This invite link is invalid, already used, or expired." footer={<Link to="/login" className="font-medium text-brand hover:underline">Go to sign in</Link>}><div /></AuthCard>;
  }
  return (
    <AuthCard title={`Join ${d.orgName}`} sub={`You've been invited as ${d.role}.`}>
      {data?.error ? <p className="mb-3 text-[13px] text-err">{data.error}</p> : null}
      {!d.loggedIn ? (
        <div className="space-y-3 text-[13px]">
          <p className="text-muted">Sign in or create an account with <span className="font-mono text-fg">{d.email}</span> to accept.</p>
          <Link to={`/login?next=${encodeURIComponent(`/invite/${d.token}`)}`} className="block h-10 rounded-lg bg-brand text-center text-[14px] font-medium leading-10 text-brand-fg hover:opacity-90">Sign in</Link>
          <Link to="/register" className="block h-10 rounded-lg border border-border text-center text-[14px] font-medium leading-10 hover:bg-surface-2">Create account</Link>
        </div>
      ) : d.emailMatches ? (
        <Form method="post">
          <button type="submit" className="h-10 w-full rounded-lg bg-brand text-[14px] font-medium text-brand-fg hover:opacity-90">Accept &amp; join {d.orgName}</button>
        </Form>
      ) : (
        <div className="space-y-2 text-[13px]">
          <p className="text-muted">This invite is for <span className="font-mono text-fg">{d.email}</span>, but you're signed in as <span className="font-mono text-fg">{d.myEmail}</span>.</p>
          <Form method="post" action="/logout"><button className="text-brand hover:underline">Sign out</button></Form>
        </div>
      )}
    </AuthCard>
  );
}
