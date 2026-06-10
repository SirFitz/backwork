import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { Form, useActionData, useLoaderData } from "@remix-run/react";
import { and, eq, isNull } from "drizzle-orm";
import { ulid } from "ulid";
import { Trash2, UserPlus } from "lucide-react";
import { Badge, Card, CardHead, Empty, PageTitle } from "~/components/ui";
import { db } from "~/db/index.server";
import { memberships, users, invitations, type Role } from "~/db/schema";
import { requireOrg, requireRole } from "~/lib/auth/context.server";
import { assertSameOrigin } from "~/lib/auth/security.server";
import { sendMail } from "~/lib/mailer.server";
import { config } from "~/lib/config.server";
import { cn } from "~/lib/utils";

const ROLES: Role[] = ["owner", "admin", "member", "viewer"];

export async function loader({ request }: LoaderFunctionArgs) {
  const ctx = await requireOrg(request);
  const members = await db
    .select({ membershipId: memberships.id, userId: users.id, name: users.name, email: users.email, role: memberships.role })
    .from(memberships)
    .innerJoin(users, eq(memberships.userId, users.id))
    .where(eq(memberships.orgId, ctx.org.id));
  const invites = await db
    .select()
    .from(invitations)
    .where(and(eq(invitations.orgId, ctx.org.id), isNull(invitations.acceptedAt)));
  return json({ members, invites, role: ctx.role, meId: ctx.user.id, orgName: ctx.org.name, publicUrl: config.publicUrl });
}

export async function action({ request }: ActionFunctionArgs) {
  assertSameOrigin(request);
  const ctx = await requireOrg(request);
  requireRole(ctx, "admin");
  const fd = await request.formData();
  const intent = String(fd.get("intent"));
  const owners = await db.select({ id: memberships.id, userId: memberships.userId }).from(memberships).where(and(eq(memberships.orgId, ctx.org.id), eq(memberships.role, "owner")));

  if (intent === "invite") {
    const email = String(fd.get("email") || "").trim().toLowerCase();
    const role = (String(fd.get("role") || "member") as Role);
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json({ error: "Enter a valid email address." }, { status: 400 });
    if (!(["owner", "admin", "member", "viewer"] as Role[]).includes(role)) return json({ error: "Invalid role." }, { status: 400 });
    if (role === "owner") requireRole(ctx, "owner");
    const token = ulid() + ulid();
    await db.insert(invitations).values({
      id: ulid(), orgId: ctx.org.id, email, role, token, invitedByUserId: ctx.user.id,
      expiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000),
    });
    const inviteLink = `${config.publicUrl}/invite/${token}`;
    // actually deliver the invite (M3); the link is also shown to the inviter as a fallback
    await sendMail(email, `You've been invited to ${ctx.org.name} on backwork`, `${ctx.user.name || ctx.user.email} invited you to join "${ctx.org.name}" on backwork.\n\nAccept the invite (valid 7 days):\n${inviteLink}\n\nIf you don't have an account yet, you'll be able to create one.`);
    return json({ inviteLink });
  }

  if (intent === "change-role") {
    const membershipId = String(fd.get("membershipId"));
    const role = String(fd.get("role")) as Role;
    const target = await db.select().from(memberships).where(and(eq(memberships.id, membershipId), eq(memberships.orgId, ctx.org.id))).limit(1);
    if (!target.length) return json({ error: "Member not found." }, { status: 404 });
    if (target[0].userId === ctx.user.id) return json({ error: "You can't change your own role." }, { status: 400 });
    if (target[0].role === "owner" || role === "owner") requireRole(ctx, "owner");
    if (target[0].role === "owner" && role !== "owner" && owners.length <= 1) return json({ error: "Can't demote the last owner." }, { status: 400 });
    await db.update(memberships).set({ role, updatedAt: new Date() }).where(eq(memberships.id, membershipId));
    return json({ ok: true });
  }

  if (intent === "remove-member") {
    const membershipId = String(fd.get("membershipId"));
    const target = await db.select().from(memberships).where(and(eq(memberships.id, membershipId), eq(memberships.orgId, ctx.org.id))).limit(1);
    if (!target.length) return json({ error: "Member not found." }, { status: 404 });
    if (target[0].role === "owner") {
      requireRole(ctx, "owner");
      if (owners.length <= 1) return json({ error: "Can't remove the last owner." }, { status: 400 });
    }
    await db.delete(memberships).where(eq(memberships.id, membershipId));
    return json({ ok: true });
  }

  if (intent === "revoke-invite") {
    await db.delete(invitations).where(and(eq(invitations.id, String(fd.get("id"))), eq(invitations.orgId, ctx.org.id)));
    return json({ ok: true });
  }

  return json({ error: "Unknown action." }, { status: 400 });
}

const FIELD = "h-9 rounded-lg border border-border bg-surface px-3 text-[13px] outline-none focus:border-brand/40";

export default function Members() {
  const d = useLoaderData<typeof loader>();
  const data = useActionData<typeof action>();
  const canManage = d.role === "owner" || d.role === "admin";

  return (
    <div className="space-y-5 animate-fade-in">
      <PageTitle title="Members" sub={`People with access to ${d.orgName}. Roles control what they can change.`} />

      {data && "inviteLink" in data && data.inviteLink ? (
        <div className="rounded-lg border border-ok/30 bg-ok/5 px-4 py-3 text-[13px]">
          <p className="font-medium text-ok">Invite created — share this one-time link:</p>
          <code className="mt-1 block break-all font-mono text-2xs text-fg/90">{data.inviteLink}</code>
        </div>
      ) : null}
      {data && "error" in data && data.error ? <div className="rounded-lg border border-err/30 bg-err/5 px-4 py-2.5 text-[13px] text-err">{data.error}</div> : null}

      <Card>
        <CardHead title="Team members" sub={`${d.members.length} member${d.members.length === 1 ? "" : "s"}`} />
        <div className="overflow-x-auto scroll-thin">
          <table className="w-full text-[13px]">
            <thead><tr className="border-b border-border text-left text-2xs uppercase tracking-wide text-faint"><th className="px-4 py-2 font-medium">Name</th><th className="px-4 py-2 font-medium">Email</th><th className="px-4 py-2 font-medium">Role</th><th className="px-4 py-2"></th></tr></thead>
            <tbody>
              {d.members.map((m) => (
                <tr key={m.membershipId} className="border-b border-border/60 last:border-0 hover:bg-surface-2/50">
                  <td className="px-4 py-2.5 font-medium">{m.name || "—"}{m.userId === d.meId ? <span className="ml-2 text-2xs text-faint">you</span> : null}</td>
                  <td className="px-4 py-2.5 font-mono text-2xs text-muted">{m.email}</td>
                  <td className="px-4 py-2.5">
                    {canManage && m.userId !== d.meId ? (
                      <Form method="post" className="inline" onSubmit={(e) => { if (!confirm(`Change ${m.email}'s role?`)) e.preventDefault(); }}>
                        <input type="hidden" name="intent" value="change-role" />
                        <input type="hidden" name="membershipId" value={m.membershipId} />
                        <select name="role" defaultValue={m.role} onChange={(e) => e.currentTarget.form?.requestSubmit()} className={cn(FIELD, "h-8 py-0")}>
                          {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
                        </select>
                      </Form>
                    ) : <Badge tone={m.role === "owner" ? "info" : "neutral"}>{m.role}</Badge>}
                  </td>
                  <td className="px-4 py-2.5 text-right">
                    {canManage && !(m.userId === d.meId) ? (
                      <Form method="post" onSubmit={(e) => { if (!confirm(`Remove ${m.email} from this organization?`)) e.preventDefault(); }}><input type="hidden" name="intent" value="remove-member" /><input type="hidden" name="membershipId" value={m.membershipId} /><button className="text-faint hover:text-err" aria-label="remove member"><Trash2 className="h-3.5 w-3.5" /></button></Form>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      {canManage ? (
        <Card>
          <CardHead title="Invite a member" sub="they'll get a one-time link to join this organization" />
          <Form method="post" className="flex flex-wrap items-end gap-2 p-4">
            <input type="hidden" name="intent" value="invite" />
            <input name="email" type="email" required placeholder="teammate@example.com" className={cn(FIELD, "min-w-[240px] flex-1")} />
            <select name="role" defaultValue="member" className={FIELD}>{ROLES.map((r) => <option key={r} value={r}>{r}</option>)}</select>
            <button type="submit" className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-brand px-3 text-[13px] font-medium text-brand-fg hover:opacity-90"><UserPlus className="h-4 w-4" /> Invite</button>
          </Form>
        </Card>
      ) : null}

      {d.invites.length > 0 ? (
        <Card>
          <CardHead title="Pending invitations" sub={`${d.invites.length} outstanding`} />
          <ul className="divide-y divide-border">
            {d.invites.map((iv) => (
              <li key={iv.id} className="flex items-center gap-3 px-4 py-2.5 text-[13px]">
                <span className="font-mono text-muted">{iv.email}</span>
                <Badge tone="neutral">{iv.role}</Badge>
                <span className="ml-auto text-2xs text-faint">expires {new Date(iv.expiresAt).toLocaleDateString()}</span>
                {canManage ? <Form method="post" onSubmit={(e) => { if (!confirm(`Revoke the invite for ${iv.email}?`)) e.preventDefault(); }}><input type="hidden" name="intent" value="revoke-invite" /><input type="hidden" name="id" value={iv.id} /><button className="text-faint hover:text-err" aria-label="revoke"><Trash2 className="h-3.5 w-3.5" /></button></Form> : null}
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
    </div>
  );
}
