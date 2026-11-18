import { eq, sql } from "drizzle-orm";
import { ulid } from "ulid";
import { db } from "~/db/index.server";
import { memberships, users } from "~/db/schema";
import { GoogleAuthError, GoogleErrorCode, GoogleIntent, type GoogleIdentity, type GoogleIntent as Intent } from "./types";

/** The slice of a user the session needs. */
export interface GoogleUser {
  id: string;
  email: string;
  googleSub: string | null;
  tokenVersion: number;
}

/** Storage the resolver depends on, so the rules can be tested without a database. */
export interface GoogleAccountStore {
  findBySub(sub: string): Promise<GoogleUser | null>;
  findByEmail(email: string): Promise<GoogleUser | null>;
  linkSub(userId: string, sub: string): Promise<void>;
  /** True when no user exists yet (the first user becomes platform admin, as on /register). */
  isEmpty(): Promise<boolean>;
  create(input: { id: string; email: string; name: string; googleSub: string; isPlatformAdmin: boolean }): Promise<GoogleUser>;
}

export interface ResolvedGoogleUser {
  user: GoogleUser;
  created: boolean;
  linked: boolean;
}

/**
 * Who a verified Google identity signs in as:
 * the user holding the Google id, else the user with that email (the id is then stored),
 * else (sign-up only) a new user. An email held by a different Google id is refused.
 */
export async function resolveGoogleUser(store: GoogleAccountStore, identity: GoogleIdentity, intent: Intent): Promise<ResolvedGoogleUser> {
  const bySub = await store.findBySub(identity.sub);
  if (bySub) return { user: bySub, created: false, linked: false };

  const byEmail = await store.findByEmail(identity.email);
  if (byEmail) {
    if (byEmail.googleSub && byEmail.googleSub !== identity.sub) throw new GoogleAuthError(GoogleErrorCode.AccountConflict);
    await store.linkSub(byEmail.id, identity.sub);
    return { user: { ...byEmail, googleSub: identity.sub }, created: false, linked: true };
  }

  if (intent !== GoogleIntent.SignUp) throw new GoogleAuthError(GoogleErrorCode.NoAccount);

  try {
    const user = await store.create({
      id: ulid(),
      email: identity.email,
      name: identity.name,
      googleSub: identity.sub,
      isPlatformAdmin: await store.isEmpty(),
    });
    return { user, created: true, linked: false };
  } catch (e) {
    // Two tabs finishing at once: the other one won, so sign in as that account.
    const winner = (await store.findBySub(identity.sub)) ?? (await store.findByEmail(identity.email));
    if (winner) return { user: winner, created: false, linked: false };
    throw e;
  }
}

const COLUMNS = { id: users.id, email: users.email, googleSub: users.googleSub, tokenVersion: users.tokenVersion };

export const drizzleGoogleStore: GoogleAccountStore = {
  async findBySub(sub) {
    return (await db.select(COLUMNS).from(users).where(eq(users.googleSub, sub)).limit(1))[0] ?? null;
  },
  async findByEmail(email) {
    return (await db.select(COLUMNS).from(users).where(sql`lower(${users.email}) = ${email.toLowerCase()}`).limit(1))[0] ?? null;
  },
  async linkSub(userId, sub) {
    await db.update(users).set({ googleSub: sub, updatedAt: new Date() }).where(eq(users.id, userId));
  },
  async isEmpty() {
    return (await db.select({ id: users.id }).from(users).limit(1)).length === 0;
  },
  async create(input) {
    const row = await db
      .insert(users)
      .values({ id: input.id, email: input.email, name: input.name, googleSub: input.googleSub, isPlatformAdmin: input.isPlatformAdmin, emailVerifiedAt: new Date(), lastLoginAt: new Date() })
      .returning(COLUMNS);
    return row[0];
  },
};

/** Stamp the sign-in and return the first organisation they belong to, if any. */
export async function recordGoogleSignIn(userId: string): Promise<string | null> {
  await db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, userId));
  const mem = await db.select({ orgId: memberships.orgId }).from(memberships).where(eq(memberships.userId, userId)).limit(1);
  return mem[0]?.orgId ?? null;
}
