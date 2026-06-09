import type { ActionFunctionArgs } from "@remix-run/node";
import { redirect } from "@remix-run/node";
import { requireUser } from "~/lib/auth/context.server";
import { setActiveOrg } from "~/lib/auth/session.server";

export async function action({ request }: ActionFunctionArgs) {
  const { memberships } = await requireUser(request);
  const fd = await request.formData();
  const orgId = String(fd.get("orgId") || "");
  // only switch into an org the user actually belongs to
  if (!memberships.some((m) => m.orgId === orgId)) return redirect("/");
  return setActiveOrg(request, orgId, "/");
}
export async function loader() {
  return redirect("/");
}
