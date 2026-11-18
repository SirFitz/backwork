import { and, eq, isNull, sql } from "drizzle-orm";
import { ulid } from "ulid";
import { db } from "~/db/index.server";
import { invitations, memberships, users } from "~/db/schema";
import { insertUserFirstAdmin } from "../users.server";
import { GoogleAuthError, GoogleErrorCode, isGoogleManagedEmail, type GoogleIdentity } from "./types";

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
  /**
   * Attach a Google id to a user that has none, in one statement: the password is dropped and
   * token_version bumped, so a password set by someone who never proved the address (and every
   * session of theirs) stops working. Returns null when the user already had a Google id.
   */
  linkSub(userId: string, sub: string): Promise<GoogleUser | null>;
  /** Insert a verified user; the first user ever becomes platform admin (decided under a lock). */
  create(input: { id: string; email: string; name: string; googleSub: string }): Promise<GoogleUser>;
}

export interface ResolvedGoogleUser {
  user: GoogleUser;
  created: boolean;
  linked: boolean;
}

async function matchExisting(store: GoogleAccountStore, identity: GoogleIdentity): Promise<ResolvedGoogleUser | null> {
  const bySub = await store.findBySub(identity.sub);
  if (bySub) return { user: bySub, created: false, linked: false };

  const byEmail = await store.findByEmail(identity.email);
  if (!byEmail) return null;
  if (byEmail.googleSub && byEmail.googleSub !== identity.sub) throw new GoogleAuthError(GoogleErrorCode.AccountConflict);
  // Only link to an existing account when Google itself vouches for owning the address.
  if (!isGoogleManagedEmail(identity.email, identity.hostedDomain)) throw new GoogleAuthError(GoogleErrorCode.LinkNotAllowed);
  const linked = await store.linkSub(byEmail.id, identity.sub);
  if (linked) return { user: linked, created: false, linked: true };
  // Lost a race: it is fine only if the winner holds this same Google id.
  const now = await store.findBySub(identity.sub);
  if (now) return { user: now, created: false, linked: false };
  throw new GoogleAuthError(GoogleErrorCode.AccountConflict);
}

/**
 * Who a verified Google identity signs in as: the user holding the Google id; else the user with
 * that email (linked, under the rules above); else a new user. Sign-in and sign-up behave the same.
 */
export async function resolveGoogleUser(store: GoogleAccountStore, identity: GoogleIdentity): Promise<ResolvedGoogleUser> {
  const existing = await matchExisting(store, identity);
  if (existing) return existing;
  try {
    const user = await store.create({ id: ulid(), email: identity.email, name: identity.name, googleSub: identity.sub });
    return { user, created: true, linked: false };
  } catch (e) {
    // Two tabs finishing at once: the other one won, so continue as that account.
    const winner = await matchExisting(store, identity);
    if (winner) return winner;
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
    const rows = await db
      .update(users)
      .set({ googleSub: sub, passwordHash: null, tokenVersion: sql`${users.tokenVersion} + 1`, updatedAt: new Date() })
      .where(and(eq(users.id, userId), isNull(users.googleSub)))
      .returning(COLUMNS);
    return rows[0] ?? null;
  },
  async create(input) {
    const rows = (await insertUserFirstAdmin(
      { id: input.id, email: input.email, name: input.name, googleSub: input.googleSub, emailVerifiedAt: new Date(), lastLoginAt: new Date() },
      COLUMNS,
    )) as GoogleUser[];
    return rows[0];
  },
};

/** Stamp the sign-in and return the first organisation they belong to, if any. */
export async function recordGoogleSignIn(userId: string): Promise<string | null> {
  await db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, userId));
  const mem = await db.select({ orgId: memberships.orgId }).from(memberships).where(eq(memberships.userId, userId)).limit(1);
  return mem[0]?.orgId ?? null;
}

/** The email an invite link was sent to, or null when the token is unknown. */
export async function inviteEmail(token: string): Promise<string | null> {
  const rows = await db.select({ email: invitations.email }).from(invitations).where(eq(invitations.token, token)).limit(1);
  return rows[0]?.email.toLowerCase() ?? null;
}
