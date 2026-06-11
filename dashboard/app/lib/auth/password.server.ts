import { hash, verify } from "@node-rs/argon2";

const DEV_PEPPER = "backwork-dev-pepper";
const PEPPER = process.env.AUTH_PEPPER || DEV_PEPPER;
// Fail fast: hashing prod passwords with a public pepper weakens them materially.
if (process.env.NODE_ENV === "production" && PEPPER === DEV_PEPPER) {
  throw new Error("AUTH_PEPPER must be set in production (refusing to use the dev default).");
}
const OPTS = { memoryCost: 19456, timeCost: 2, parallelism: 1 };

export function hashPassword(pw: string): Promise<string> {
  return hash(PEPPER + pw, OPTS);
}

export async function verifyPassword(stored: string, pw: string): Promise<boolean> {
  try {
    return await verify(stored, PEPPER + pw);
  } catch {
    return false;
  }
}

export function passwordError(pw: string): string | null {
  if (pw.length < 10) return "Password must be at least 10 characters.";
  if (!/[a-zA-Z]/.test(pw) || !/[0-9]/.test(pw)) return "Use at least one letter and one number.";
  return null;
}
