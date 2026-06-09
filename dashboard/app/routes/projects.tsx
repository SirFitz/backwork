import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { Form, useActionData, useLoaderData } from "@remix-run/react";
import { and, eq } from "drizzle-orm";
import { ulid } from "ulid";
import { randomBytes } from "node:crypto";
import { KeyRound, Plus, RefreshCw, Trash2 } from "lucide-react";
import { Badge, Card, CardHead, Empty, PageTitle } from "~/components/ui";
import { db } from "~/db/index.server";
import { projects } from "~/db/schema";
import { requireOrg, requireRole } from "~/lib/auth/context.server";
import { hashToken, tenantOf } from "~/lib/tenant.server";
import { config } from "~/lib/config.server";
import { slugify, cn } from "~/lib/utils";

function newToken(): string {
  return "bw_" + randomBytes(24).toString("hex");
}

export async function loader({ request }: LoaderFunctionArgs) {
  const ctx = await requireOrg(request);
  const rows = await db
    .select({ id: projects.id, name: projects.name, slug: projects.slug, hasToken: projects.ingestTokenHash })
    .from(projects)
    .where(eq(projects.orgId, ctx.org.id));
  return json({
    projects: rows.map((p) => ({ id: p.id, name: p.name, slug: p.slug, hasToken: !!p.hasToken })),
    role: ctx.role,
    publicUrl: config.publicUrl,
    isPlatform: tenantOf(ctx.org.id).platform,
  });
}

export async function action({ request }: ActionFunctionArgs) {
  const ctx = await requireOrg(request);
  requireRole(ctx, "admin");
  const fd = await request.formData();
  const intent = String(fd.get("intent"));

  if (intent === "create") {
    const name = String(fd.get("name") || "").trim();
    if (!name) return json({ error: "Project name is required." }, { status: 400 });
    let slug = slugify(name);
    for (let i = 1; ; i++) {
      const hit = await db.select({ id: projects.id }).from(projects).where(and(eq(projects.orgId, ctx.org.id), eq(projects.slug, slug))).limit(1);
      if (!hit.length) break;
      slug = `${slugify(name)}-${i + 1}`;
      if (i > 50) { slug = `${slugify(name)}-${ulid().slice(-5).toLowerCase()}`; break; }
    }
    const token = newToken();
    await db.insert(projects).values({ id: ulid(), orgId: ctx.org.id, name, slug, ingestTokenHash: hashToken(token) });
    return json({ token, slug });
  }

  if (intent === "regenerate") {
    const id = String(fd.get("id"));
    const proj = await db.select().from(projects).where(and(eq(projects.id, id), eq(projects.orgId, ctx.org.id))).limit(1);
    if (!proj.length) return json({ error: "Project not found." }, { status: 404 });
    const token = newToken();
    await db.update(projects).set({ ingestTokenHash: hashToken(token), updatedAt: new Date() }).where(eq(projects.id, id));
    return json({ token, slug: proj[0].slug });
  }

  if (intent === "delete") {
    await db.delete(projects).where(and(eq(projects.id, String(fd.get("id"))), eq(projects.orgId, ctx.org.id)));
    return json({ ok: true });
  }

  return json({ error: "Unknown action." }, { status: 400 });
}

const FIELD = "h-9 rounded-lg border border-border bg-surface px-3 text-[13px] outline-none focus:border-brand/40";

function CodeBlock({ children }: { children: string }) {
  return <pre className="overflow-x-auto scroll-thin rounded-lg border border-border bg-surface-2 px-3.5 py-3 font-mono text-2xs leading-relaxed text-fg/90">{children}</pre>;
}

export default function Projects() {
  const d = useLoaderData<typeof loader>();
  const data = useActionData<typeof action>();
  const canManage = d.role === "owner" || d.role === "admin";
  const tok = data && "token" in data ? data.token : null;

  const agentCmd = tok
    ? `curl -fsSL ${d.publicUrl}/install.sh | sh -s -- \\\n  --token ${tok} \\\n  --name $(hostname)`
    : "";
  const otlpEnv = tok
    ? `OTEL_EXPORTER_OTLP_ENDPOINT=${d.publicUrl}/otlp\nOTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf\nOTEL_EXPORTER_OTLP_HEADERS=Authorization=Bearer ${tok}\nOTEL_SERVICE_NAME=<your-service>`
    : "";

  return (
    <div className="space-y-5 animate-fade-in">
      <PageTitle title="Projects" sub="A project is an environment or app you ship telemetry from. Each has its own ingest token; data is isolated to your organization." />

      {tok ? (
        <Card className="border-ok/40">
          <CardHead title="Ingest token created" sub="copy it now — it is shown only once" />
          <div className="space-y-3 p-4">
            <code className="block break-all rounded-lg border border-border bg-surface-2 px-3 py-2 font-mono text-[13px] text-fg">{tok}</code>
            <div>
              <div className="mb-1 text-2xs font-medium text-muted">Ship logs from a server</div>
              <CodeBlock>{agentCmd}</CodeBlock>
            </div>
            <div>
              <div className="mb-1 text-2xs font-medium text-muted">Send traces from an app (OpenTelemetry)</div>
              <CodeBlock>{otlpEnv}</CodeBlock>
            </div>
          </div>
        </Card>
      ) : null}
      {data && "error" in data && data.error ? <div className="rounded-lg border border-err/30 bg-err/5 px-4 py-2.5 text-[13px] text-err">{data.error}</div> : null}

      <Card>
        <CardHead title="Projects" sub={`${d.projects.length} project${d.projects.length === 1 ? "" : "s"}`} />
        {d.projects.length === 0 ? (
          <Empty title="No projects yet">{canManage ? "Create one below to get an ingest token." : "An admin hasn't created any projects yet."}</Empty>
        ) : (
          <ul className="divide-y divide-border">
            {d.projects.map((p) => (
              <li key={p.id} className="flex items-center gap-3 px-4 py-2.5 text-[13px]">
                <KeyRound className="h-3.5 w-3.5 text-faint" />
                <span className="font-medium">{p.name}</span>
                <span className="font-mono text-2xs text-faint">{p.slug}</span>
                {p.hasToken ? <Badge tone="ok">token set</Badge> : <Badge tone="warn">no token</Badge>}
                {canManage ? (
                  <div className="ml-auto flex items-center gap-3">
                    <Form method="post"><input type="hidden" name="intent" value="regenerate" /><input type="hidden" name="id" value={p.id} /><button className="inline-flex items-center gap-1 text-2xs text-muted hover:text-fg"><RefreshCw className="h-3 w-3" /> regenerate</button></Form>
                    <Form method="post"><input type="hidden" name="intent" value="delete" /><input type="hidden" name="id" value={p.id} /><button className="text-faint hover:text-err" aria-label="delete project"><Trash2 className="h-3.5 w-3.5" /></button></Form>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Card>

      {canManage ? (
        <Card>
          <CardHead title="New project" sub="generates a one-time ingest token" />
          <Form method="post" className="flex flex-wrap items-end gap-2 p-4">
            <input type="hidden" name="intent" value="create" />
            <input name="name" required placeholder="Production, Staging, my-api…" className={cn(FIELD, "min-w-[240px] flex-1")} />
            <button type="submit" className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-brand px-3 text-[13px] font-medium text-brand-fg hover:opacity-90"><Plus className="h-4 w-4" /> Create project</button>
          </Form>
        </Card>
      ) : null}
    </div>
  );
}
