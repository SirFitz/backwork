import type { ActionFunctionArgs, LoaderFunctionArgs, MetaFunction } from "@remix-run/node";
import { json, redirect } from "@remix-run/node";
import { Form, useLoaderData } from "@remix-run/react";
import { useState } from "react";
import { Check, Copy, KeyRound, Plus, Trash2 } from "lucide-react";
import { Badge, Card, CardHead, Empty, PageTitle } from "~/components/ui";
import { requireOrg, requireRole } from "~/lib/auth/context.server";
import { assertSameOrigin } from "~/lib/auth/security.server";
import { getAuthSession, commitAuthSession } from "~/lib/auth/session.server";
import { createApiKey, listApiKeys, revokeApiKey } from "~/lib/apikey.server";
import { logAudit } from "~/lib/audit.server";
import { config } from "~/lib/config.server";

export const meta: MetaFunction = () => [{ title: "API keys · backwork" }];

export async function loader({ request }: LoaderFunctionArgs) {
  const ctx = await requireOrg(request);
  const keys = await listApiKeys(ctx.org.id);
  const s = await getAuthSession(request);
  const created = (s.get("newApiKey") as string) || null;
  return json(
    { keys, role: ctx.role, created, publicUrl: config.publicUrl },
    { headers: { "Set-Cookie": await commitAuthSession(s) } }, // consume the flash
  );
}

export async function action({ request }: ActionFunctionArgs) {
  const ctx = await requireOrg(request);
  assertSameOrigin(request);
  requireRole(ctx, "admin");
  const fd = await request.formData();
  const intent = String(fd.get("intent"));

  if (intent === "create") {
    const name = String(fd.get("name") || "").trim().slice(0, 80) || "API key";
    const token = await createApiKey(ctx.org.id, name, ctx.user.id);
    void logAudit({ request, orgId: ctx.org.id, actorUserId: ctx.user.id, action: "apikey.create", target: { name } });
    const s = await getAuthSession(request);
    s.flash("newApiKey", token);
    return redirect("/api-keys", { headers: { "Set-Cookie": await commitAuthSession(s) } });
  }
  if (intent === "revoke") {
    const id = String(fd.get("id"));
    const n = await revokeApiKey(ctx.org.id, id);
    if (n) void logAudit({ request, orgId: ctx.org.id, actorUserId: ctx.user.id, action: "apikey.revoke", target: { id } });
    return redirect("/api-keys");
  }
  return json({ error: "Unknown action." }, { status: 400 });
}

function CopyBtn({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      onClick={() => { navigator.clipboard?.writeText(text); setDone(true); setTimeout(() => setDone(false), 1500); }}
      className="inline-flex items-center gap-1 rounded-md border border-border bg-surface px-2 py-1 text-2xs font-medium text-muted hover:text-fg"
    >
      {done ? <Check className="h-3.5 w-3.5 text-ok" /> : <Copy className="h-3.5 w-3.5" />} {done ? "copied" : "copy"}
    </button>
  );
}

function stamp(d: string | Date | null) {
  return d ? new Date(d).toISOString().replace("T", " ").slice(0, 16) + "Z" : "never";
}

export default function ApiKeys() {
  const { keys, role, created, publicUrl } = useLoaderData<typeof loader>();
  const canManage = role === "owner" || role === "admin";
  const curl = `curl -H "Authorization: Bearer <API_KEY>" ${publicUrl}/api/v1/errors`;

  return (
    <div className="space-y-5 animate-fade-in">
      <PageTitle title="API keys" sub="Read-only keys for the public API — query your org's errors, incidents, and service health programmatically. Keys are org-scoped and shown once." />

      {created ? (
        <Card>
          <CardHead title="API key created" sub="copy it now — it is shown only once" />
          <div className="flex items-center gap-2 p-4">
            <code className="block flex-1 break-all rounded-lg border border-border bg-surface-2 px-3 py-2 font-mono text-[13px] text-fg">{created}</code>
            <CopyBtn text={created} />
          </div>
        </Card>
      ) : null}

      <Card>
        <CardHead title="Your keys" sub={`${keys.length} key${keys.length === 1 ? "" : "s"}`} />
        {keys.length === 0 ? (
          <Empty icon={<KeyRound className="h-5 w-5" />} title="No API keys yet">{canManage ? "Create one below to start using the API." : "An admin hasn't created any API keys yet."}</Empty>
        ) : (
          <ul className="divide-y divide-border">
            {keys.map((k) => (
              <li key={k.id} className="flex items-center justify-between gap-4 px-4 py-2.5">
                <div className="min-w-0">
                  <div className="truncate text-[13px] font-medium text-fg">{k.name || "API key"}</div>
                  <div className="text-2xs text-faint">created {stamp(k.createdAt)} · last used {stamp(k.lastUsedAt)}</div>
                </div>
                {canManage ? (
                  <Form method="post" onSubmit={(e) => { if (!confirm(`Revoke "${k.name || "this key"}"? Any script using it stops working immediately.`)) e.preventDefault(); }}>
                    <input type="hidden" name="intent" value="revoke" />
                    <input type="hidden" name="id" value={k.id} />
                    <button type="submit" className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-2xs font-medium text-err hover:bg-err/10"><Trash2 className="h-3.5 w-3.5" /> revoke</button>
                  </Form>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Card>

      {canManage ? (
        <Card>
          <CardHead title="Create a key" sub="give it a name so you can tell keys apart" />
          <Form method="post" className="flex flex-wrap items-end gap-2 p-4">
            <input type="hidden" name="intent" value="create" />
            <input name="name" placeholder="e.g. CI dashboard, on-call script" className="h-9 min-w-[220px] flex-1 rounded-lg border border-border bg-surface px-3 text-[13px] outline-none focus:border-brand/40" />
            <button type="submit" className="inline-flex items-center gap-1.5 rounded-lg bg-brand px-3 py-2 text-2xs font-semibold text-white hover:bg-brand/90"><Plus className="h-3.5 w-3.5" /> Create key</button>
          </Form>
        </Card>
      ) : null}

      <Card>
        <CardHead title="Using the API" sub="bearer-authed, JSON, org-scoped" />
        <div className="space-y-3 p-4 text-[13px]">
          <p className="text-muted">Send your key as a bearer token. All responses are JSON, scoped to this organization.</p>
          <pre className="overflow-x-auto scroll-thin rounded-lg border border-border bg-surface-2 px-3.5 py-3 font-mono text-2xs leading-relaxed text-fg/90">{curl}</pre>
          <div className="text-2xs text-muted">
            <div className="mb-1 font-medium text-fg">Endpoints</div>
            <ul className="space-y-0.5 font-mono text-faint">
              <li><span className="text-accent">GET</span> /api/v1/me — verify the key + see its org</li>
              <li><span className="text-accent">GET</span> /api/v1/errors?status=open&service=&limit=100</li>
              <li><span className="text-accent">GET</span> /api/v1/incidents</li>
              <li><span className="text-accent">GET</span> /api/v1/services</li>
            </ul>
          </div>
          <div className="text-2xs text-muted">
            <div className="mb-1 font-medium text-fg">Or use the CLI</div>
            <pre className="overflow-x-auto scroll-thin rounded-lg border border-border bg-surface-2 px-3.5 py-3 font-mono leading-relaxed text-fg/90">{`npm i -g @sirfitz/backwork-cli\nexport BACKWORK_API_KEY=<your key>\nbw errors`}</pre>
          </div>
        </div>
      </Card>
    </div>
  );
}
