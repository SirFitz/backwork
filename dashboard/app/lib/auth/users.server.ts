import { sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { db } from "~/db/index.server";
import { users } from "~/db/schema";

/** Arbitrary constant naming the "who is the first user" lock. */
const FIRST_USER_LOCK = 7_101_001;

export type NewUser = Omit<typeof users.$inferInsert, "isPlatformAdmin">;

/**
 * Insert a user. The very first user ever becomes platform admin; the check and the insert run
 * under one advisory lock so two sign-ups at the same moment cannot both claim it.
 */
export async function insertUserFirstAdmin(values: NewUser, returning: Record<string, AnyPgColumn>): Promise<unknown[]> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${FIRST_USER_LOCK})`);
    const any = await tx.select({ id: users.id }).from(users).limit(1);
    return (await tx.insert(users).values({ ...values, isPlatformAdmin: any.length === 0 }).returning(returning)) as unknown[];
  });
}
