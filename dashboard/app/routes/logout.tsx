import type { ActionFunctionArgs } from "@remix-run/node";
import { redirect } from "@remix-run/node";
import { eq, sql } from "drizzle-orm";
import { db } from "~/db/index.server";
import { users } from "~/db/schema";
import { getAuthSession, logout } from "~/lib/auth/session.server";
import { assertSameOrigin } from "~/lib/auth/security.server";

export async function action({ request }: ActionFunctionArgs) {
  assertSameOrigin(request);
  // bump token_version so any captured copy of this session cookie stops working
  const s = await getAuthSession(request);
  const uid = s.get("userId");
  if (uid) await db.update(users).set({ tokenVersion: sql`token_version + 1` }).where(eq(users.id, uid));
  return logout(request);
}
export async function loader() {
  return redirect("/");
}
