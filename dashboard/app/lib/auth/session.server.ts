import { createCookieSessionStorage, redirect } from "@remix-run/node";

const storage = createCookieSessionStorage({
  cookie: {
    name: "backwork_auth",
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    secrets: [process.env.SESSION_SECRET || "backwork-dev-session-secret"],
    secure: process.env.NODE_ENV === "production",
    maxAge: 60 * 60 * 24 * 30,
  },
});

export function getAuthSession(request: Request) {
  return storage.getSession(request.headers.get("Cookie"));
}
export function commitAuthSession(s: Awaited<ReturnType<typeof getAuthSession>>) {
  return storage.commitSession(s);
}

export async function createUserSession(userId: string, activeOrgId: string | null, redirectTo: string) {
  const s = await storage.getSession();
  s.set("userId", userId);
  if (activeOrgId) s.set("activeOrgId", activeOrgId);
  return redirect(redirectTo, { headers: { "Set-Cookie": await storage.commitSession(s) } });
}

export async function setActiveOrg(request: Request, orgId: string, redirectTo: string) {
  const s = await getAuthSession(request);
  s.set("activeOrgId", orgId);
  return redirect(redirectTo, { headers: { "Set-Cookie": await storage.commitSession(s) } });
}

export async function logout(request: Request) {
  const s = await getAuthSession(request);
  return redirect("/login", { headers: { "Set-Cookie": await storage.destroySession(s) } });
}
