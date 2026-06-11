import { createCookieSessionStorage, redirect } from "@remix-run/node";

const DEV_SESSION_SECRET = "backwork-dev-session-secret";
const SESSION_SECRET = process.env.SESSION_SECRET || DEV_SESSION_SECRET;
// Fail fast: a production deploy without a real SESSION_SECRET would sign auth
// cookies with a public constant → forgeable sessions. Crash loudly instead.
if (process.env.NODE_ENV === "production" && SESSION_SECRET === DEV_SESSION_SECRET) {
  throw new Error("SESSION_SECRET must be set in production (refusing to use the dev default).");
}

const storage = createCookieSessionStorage({
  cookie: {
    name: "backwork_auth",
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    secrets: [SESSION_SECRET],
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

export async function createUserSession(userId: string, activeOrgId: string | null, redirectTo: string, tokenVersion = 0) {
  const s = await storage.getSession();
  s.set("userId", userId);
  s.set("tv", tokenVersion);
  if (activeOrgId) s.set("activeOrgId", activeOrgId);
  return redirect(redirectTo, { headers: { "Set-Cookie": await storage.commitSession(s) } });
}

/** Re-issue the current session's cookie with a new token version (used after a
 *  password change so THIS device stays signed in while others are invalidated). */
export async function reissueTokenVersion(request: Request, tokenVersion: number): Promise<string> {
  const s = await getAuthSession(request);
  s.set("tv", tokenVersion);
  return storage.commitSession(s);
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
