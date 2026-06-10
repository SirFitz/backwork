import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json, redirect } from "@remix-run/node";
import { Form, useActionData, useNavigation } from "@remix-run/react";
import { eq } from "drizzle-orm";
import { ulid } from "ulid";
import { db } from "~/db/index.server";
import { orgs, memberships } from "~/db/schema";
import { requireUser } from "~/lib/auth/context.server";
import { setActiveOrg } from "~/lib/auth/session.server";
import { assertSameOrigin } from "~/lib/auth/security.server";
import { slugify } from "~/lib/utils";
import { AuthCard, AUTH_FIELD } from "~/components/authcard";

export async function loader({ request }: LoaderFunctionArgs) {
  const { user, memberships: mems } = await requireUser(request);
  if (mems.length > 0) throw redirect("/");
  return json({ name: user.name });
}

async function uniqueSlug(base: string): Promise<string> {
  const root = slugify(base);
  for (let i = 0; i < 50; i++) {
    const slug = i === 0 ? root : `${root}-${i + 1}`;
    const hit = await db.select({ id: orgs.id }).from(orgs).where(eq(orgs.slug, slug)).limit(1);
    if (!hit.length) return slug;
  }
  return `${root}-${ulid().slice(-6).toLowerCase()}`;
}

export async function action({ request }: ActionFunctionArgs) {
  assertSameOrigin(request);
  const { user } = await requireUser(request);
  const fd = await request.formData();
  const name = String(fd.get("name") || "").trim();
  if (!name) return json({ error: "Organization name is required." }, { status: 400 });
  if (name.length > 80) return json({ error: "Organization name is too long (80 max)." }, { status: 400 });

  const orgId = ulid();
  await db.insert(orgs).values({ id: orgId, name, slug: await uniqueSlug(name) });
  await db.insert(memberships).values({ id: ulid(), userId: user.id, orgId, role: "owner" });
  return setActiveOrg(request, orgId, "/");
}

export default function Onboarding() {
  const data = useActionData<typeof action>();
  const nav = useNavigation();
  return (
    <AuthCard title="Create your organization" sub="This is the workspace your team and monitored infrastructure live in.">
      <Form method="post" className="space-y-3">
        <input name="name" type="text" required placeholder="Acme Inc" className={AUTH_FIELD} autoFocus />
        {data?.error ? <p className="text-[13px] text-err">{data.error}</p> : null}
        <button type="submit" disabled={nav.state !== "idle"} className="h-10 w-full rounded-lg bg-brand text-[14px] font-medium text-brand-fg hover:opacity-90 disabled:opacity-60">
          {nav.state !== "idle" ? "Creating…" : "Create organization"}
        </button>
      </Form>
    </AuthCard>
  );
}
