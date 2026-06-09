import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { Form, useActionData, useLoaderData } from "@remix-run/react";
import { and, eq } from "drizzle-orm";
import { ulid } from "ulid";
import { Plus, Trash2, X } from "lucide-react";
import { Badge, Card, CardHead, Empty, PageTitle } from "~/components/ui";
import { db } from "~/db/index.server";
import { teams, teamMembers, memberships, users } from "~/db/schema";
import { requireOrg, requireRole } from "~/lib/auth/context.server";
import { slugify } from "~/lib/utils";
import { cn } from "~/lib/utils";

export async function loader({ request }: LoaderFunctionArgs) {
  const ctx = await requireOrg(request);
  const teamList = await db.select().from(teams).where(eq(teams.orgId, ctx.org.id));
  const tms = await db
    .select({ id: teamMembers.id, teamId: teamMembers.teamId, userId: users.id, name: users.name, email: users.email })
    .from(teamMembers)
    .innerJoin(users, eq(teamMembers.userId, users.id))
    .innerJoin(teams, eq(teamMembers.teamId, teams.id))
    .where(eq(teams.orgId, ctx.org.id));
  const orgMembers = await db
    .select({ userId: users.id, name: users.name, email: users.email })
    .from(memberships)
    .innerJoin(users, eq(memberships.userId, users.id))
    .where(eq(memberships.orgId, ctx.org.id));
  return json({ teams: teamList, members: tms, orgMembers, role: ctx.role });
}

export async function action({ request }: ActionFunctionArgs) {
  const ctx = await requireOrg(request);
  requireRole(ctx, "admin");
  const fd = await request.formData();
  const intent = String(fd.get("intent"));

  if (intent === "create-team") {
    const name = String(fd.get("name") || "").trim();
    if (!name) return json({ error: "Team name is required." }, { status: 400 });
    let slug = slugify(name);
    for (let i = 1; ; i++) {
      const hit = await db.select({ id: teams.id }).from(teams).where(and(eq(teams.orgId, ctx.org.id), eq(teams.slug, slug))).limit(1);
      if (!hit.length) break;
      slug = `${slugify(name)}-${i + 1}`;
      if (i > 50) { slug = `${slugify(name)}-${ulid().slice(-5).toLowerCase()}`; break; }
    }
    await db.insert(teams).values({ id: ulid(), orgId: ctx.org.id, name, slug });
    return json({ ok: true });
  }

  if (intent === "delete-team") {
    await db.delete(teams).where(and(eq(teams.id, String(fd.get("teamId"))), eq(teams.orgId, ctx.org.id)));
    return json({ ok: true });
  }

  if (intent === "add-member") {
    const teamId = String(fd.get("teamId"));
    const userId = String(fd.get("userId"));
    const team = await db.select({ id: teams.id }).from(teams).where(and(eq(teams.id, teamId), eq(teams.orgId, ctx.org.id))).limit(1);
    const isMember = await db.select({ id: memberships.id }).from(memberships).where(and(eq(memberships.userId, userId), eq(memberships.orgId, ctx.org.id))).limit(1);
    if (!team.length || !isMember.length) return json({ error: "Invalid team or user." }, { status: 400 });
    const dup = await db.select({ id: teamMembers.id }).from(teamMembers).where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, userId))).limit(1);
    if (!dup.length) await db.insert(teamMembers).values({ id: ulid(), teamId, userId });
    return json({ ok: true });
  }

  if (intent === "remove-member") {
    await db.delete(teamMembers).where(eq(teamMembers.id, String(fd.get("id"))));
    return json({ ok: true });
  }

  return json({ error: "Unknown action." }, { status: 400 });
}

const FIELD = "h-9 rounded-lg border border-border bg-surface px-3 text-[13px] outline-none focus:border-brand/40";

export default function Teams() {
  const d = useLoaderData<typeof loader>();
  const data = useActionData<typeof action>();
  const canManage = d.role === "owner" || d.role === "admin";
  const byTeam = (id: string) => d.members.filter((m) => m.teamId === id);

  return (
    <div className="space-y-5 animate-fade-in">
      <PageTitle title="Teams" sub="Group members into teams. Teams will scope which projects each group can see." />

      {data && "error" in data && data.error ? <div className="rounded-lg border border-err/30 bg-err/5 px-4 py-2.5 text-[13px] text-err">{data.error}</div> : null}

      {canManage ? (
        <Card>
          <CardHead title="New team" sub="e.g. Platform, Payments, On-call" />
          <Form method="post" className="flex flex-wrap items-end gap-2 p-4">
            <input type="hidden" name="intent" value="create-team" />
            <input name="name" required placeholder="Team name" className={cn(FIELD, "min-w-[240px] flex-1")} />
            <button type="submit" className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-brand px-3 text-[13px] font-medium text-brand-fg hover:opacity-90"><Plus className="h-4 w-4" /> Create team</button>
          </Form>
        </Card>
      ) : null}

      {d.teams.length === 0 ? (
        <Card><Empty title="No teams yet">{canManage ? "Create one above to start grouping members." : "An admin hasn't created any teams yet."}</Empty></Card>
      ) : (
        d.teams.map((t) => {
          const mem = byTeam(t.id);
          const memberIds = new Set(mem.map((m) => m.userId));
          const addable = d.orgMembers.filter((m) => !memberIds.has(m.userId));
          return (
            <Card key={t.id}>
              <CardHead title={t.name} sub={`${mem.length} member${mem.length === 1 ? "" : "s"}`} right={canManage ? <Form method="post"><input type="hidden" name="intent" value="delete-team" /><input type="hidden" name="teamId" value={t.id} /><button className="text-2xs text-faint hover:text-err">delete team</button></Form> : null} />
              <ul className="divide-y divide-border">
                {mem.length === 0 ? <li className="px-4 py-3 text-[13px] text-faint">No members in this team.</li> : mem.map((m) => (
                  <li key={m.id} className="flex items-center gap-3 px-4 py-2.5 text-[13px]">
                    <span className="font-medium">{m.name || m.email}</span>
                    <span className="font-mono text-2xs text-faint">{m.email}</span>
                    {canManage ? <Form method="post" className="ml-auto"><input type="hidden" name="intent" value="remove-member" /><input type="hidden" name="id" value={m.id} /><button className="text-faint hover:text-err" aria-label="remove"><X className="h-3.5 w-3.5" /></button></Form> : null}
                  </li>
                ))}
              </ul>
              {canManage && addable.length > 0 ? (
                <div className="border-t border-border p-3">
                  <Form method="post" className="flex items-center gap-2">
                    <input type="hidden" name="intent" value="add-member" />
                    <input type="hidden" name="teamId" value={t.id} />
                    <select name="userId" className={cn(FIELD, "flex-1")} defaultValue="">
                      <option value="" disabled>Add a member…</option>
                      {addable.map((m) => <option key={m.userId} value={m.userId}>{m.name || m.email} ({m.email})</option>)}
                    </select>
                    <button type="submit" className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-border px-3 text-[13px] font-medium hover:bg-surface-2"><Plus className="h-4 w-4" /> Add</button>
                  </Form>
                </div>
              ) : null}
            </Card>
          );
        })
      )}
    </div>
  );
}
