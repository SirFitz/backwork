import { createCipheriv, createDecipheriv, randomBytes, hkdfSync } from "node:crypto";

// AES-256-GCM encryption for secrets at rest (channel credentials, etc.).
// Key is HKDF-derived per purpose from ENCRYPTION_KEY (or SESSION_SECRET).
// Envelope: "enc:v1:" + base64(iv).base64(ciphertext).base64(tag).
const SECRET = process.env.ENCRYPTION_KEY || process.env.SESSION_SECRET || "backwork-dev-encryption-secret";
const PREFIX = "enc:v1:";

function keyFor(purpose: string): Buffer {
  return Buffer.from(hkdfSync("sha256", Buffer.from(SECRET), Buffer.alloc(0), Buffer.from(`backwork:${purpose}`), 32));
}

export function isEncrypted(v: string): boolean {
  return typeof v === "string" && v.startsWith(PREFIX);
}

export function encryptSecret(plain: string, purpose = "channel"): string {
  if (!plain || isEncrypted(plain)) return plain;
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", keyFor(purpose), iv);
  const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  const tag = c.getAuthTag();
  return PREFIX + [iv, ct, tag].map((b) => b.toString("base64")).join(".");
}

export function decryptSecret(val: string, purpose = "channel"): string {
  if (!val || !isEncrypted(val)) return val; // legacy plaintext passthrough
  try {
    const [ivB, ctB, tagB] = val.slice(PREFIX.length).split(".");
    const d = createDecipheriv("aes-256-gcm", keyFor(purpose), Buffer.from(ivB, "base64"));
    d.setAuthTag(Buffer.from(tagB, "base64"));
    return Buffer.concat([d.update(Buffer.from(ctB, "base64")), d.final()]).toString("utf8");
  } catch {
    return "";
  }
}
