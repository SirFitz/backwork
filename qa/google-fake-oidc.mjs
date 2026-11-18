// A tiny stand-in for Google's OpenID Connect endpoints, for trying "Continue with Google" locally
// without any Google credentials (BAC-101). Tests only; never run against a backwork people use.
//
//   node qa/google-fake-oidc.mjs            (listens on FAKE_OIDC_PORT, default 4010)
//
// Point the dashboard at it (honoured only outside production, or with GOOGLE_SIGNIN_TEST_ENDPOINTS=1):
//   GOOGLE_SIGNIN_CLIENT_ID=fake-client GOOGLE_SIGNIN_CLIENT_SECRET=fake-secret
//   GOOGLE_SIGNIN_AUTH_URL=http://localhost:4010/authorize     (opened by the browser)
//   GOOGLE_SIGNIN_TOKEN_URL=http://<host>:4010/token           (called by the dashboard)
//   GOOGLE_SIGNIN_JWKS_URL=http://<host>:4010/certs
//
// Pick who signs in next with:  curl -X POST localhost:4010/__next -d '{"email":"a@b.com","name":"Ada","sub":"1"}'
//   extra keys: "email_verified": false, "cancel": true (consent refused), "sticky": true (keep for later runs)
import { createServer } from "node:http";
import { createHash, createSign, generateKeyPairSync, randomBytes } from "node:crypto";

const PORT = Number(process.env.FAKE_OIDC_PORT || 4010);
const CLIENT_ID = process.env.GOOGLE_SIGNIN_CLIENT_ID || "fake-client";
const CLIENT_SECRET = process.env.GOOGLE_SIGNIN_CLIENT_SECRET || "fake-secret";
const ISSUER = "https://accounts.google.com";
const KID = "fake-key-1";

const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: "jwk" }), kid: KID, alg: "RS256", use: "sig" };
const codes = new Map(); // code -> { nonce, challenge, identity }
let nextIdentity = { sub: "fake-sub-1", email: "ada@example.com", name: "Ada Lovelace", email_verified: true };
let sticky = false;

const b64 = (v) => Buffer.from(JSON.stringify(v)).toString("base64url");
function signIdToken(claims) {
  const head = b64({ alg: "RS256", kid: KID, typ: "JWT" });
  const body = b64(claims);
  const sig = createSign("RSA-SHA256").update(`${head}.${body}`).sign(privateKey).toString("base64url");
  return `${head}.${body}.${sig}`;
}
function readBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => resolve(data));
  });
}
function send(res, status, body, type = "application/json") {
  res.writeHead(status, { "content-type": type });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
}

createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (req.method === "GET" && url.pathname === "/authorize") {
    const q = url.searchParams;
    const redirect = new URL(q.get("redirect_uri") || "");
    if (q.get("client_id") !== CLIENT_ID || q.get("code_challenge_method") !== "S256" || !q.get("code_challenge")) return send(res, 400, { error: "bad authorize request" });
    redirect.searchParams.set("state", q.get("state") || "");
    if (nextIdentity.cancel) {
      redirect.searchParams.set("error", "access_denied");
    } else {
      const code = randomBytes(12).toString("hex");
      codes.set(code, { nonce: q.get("nonce"), challenge: q.get("code_challenge"), identity: nextIdentity });
      redirect.searchParams.set("code", code);
    }
    if (!sticky) nextIdentity = { sub: "fake-sub-1", email: "ada@example.com", name: "Ada Lovelace", email_verified: true };
    res.writeHead(302, { location: redirect.toString() });
    return res.end();
  }
  if (req.method === "POST" && url.pathname === "/token") {
    const f = new URLSearchParams(await readBody(req));
    const entry = codes.get(f.get("code") || "");
    codes.delete(f.get("code") || "");
    if (f.get("client_id") !== CLIENT_ID || f.get("client_secret") !== CLIENT_SECRET || !entry) return send(res, 400, { error: "invalid_grant" });
    const challenge = createHash("sha256").update(f.get("code_verifier") || "").digest("base64url");
    if (challenge !== entry.challenge) return send(res, 400, { error: "invalid_grant", error_description: "PKCE mismatch" });
    const now = Math.floor(Date.now() / 1000);
    const { cancel: _c, ...person } = entry.identity;
    return send(res, 200, { access_token: "fake", token_type: "Bearer", id_token: signIdToken({ iss: ISSUER, aud: CLIENT_ID, iat: now, exp: now + 3600, nonce: entry.nonce, ...person }) });
  }
  if (req.method === "GET" && url.pathname === "/certs") return send(res, 200, { keys: [jwk] });
  if (req.method === "POST" && url.pathname === "/__next") {
    const body = JSON.parse((await readBody(req)) || "{}");
    sticky = !!body.sticky;
    const { sticky: _s, ...person } = body;
    nextIdentity = { sub: "fake-sub-1", email_verified: true, name: "Ada Lovelace", ...person };
    return send(res, 200, { ok: true, next: nextIdentity });
  }
  send(res, 404, { error: "not found" });
}).listen(PORT, () => console.log(`fake OIDC provider on :${PORT}`));
