import type { LoaderFunctionArgs, MetaFunction } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import { Card, CardHead, Empty, PageTitle } from "~/components/ui";
import { requireOrg, requireRole } from "~/lib/auth/context.server";
import { recentAudit } from "~/lib/audit.server";

export const meta: MetaFunction = () => [{ title: "Audit log · backwork" }];

export async function loader({ request }: LoaderFunctionArgs) {
  const ctx = await requireOrg(request);
  requireRole(ctx, "admin");
  const entries = await recentAudit(ctx.org.id, 100);
  return json({ entries });
}

// Deterministic UTC stamp (no locale/timezone hydration mismatch).
function stamp(d: string | Date) {
  return new Date(d).toISOString().replace("T", " ").slice(0, 19) + "Z";
}

export default function Audit() {
  const { entries } = useLoaderData<typeof loader>();
  return (
    <div className="space-y-5 animate-fade-in">
      <PageTitle title="Audit log" sub="Sensitive actions in this organization — logins, role changes, project & token changes. Newest first." />
      <Card>
        <CardHead title="Recent activity" sub={`${entries.length} event${entries.length === 1 ? "" : "s"} · last 100`} />
        {entries.length === 0 ? (
          <Empty title="No audit events yet">Logins, role changes, and project/token changes will appear here as they happen.</Empty>
        ) : (
          <div className="overflow-x-auto scroll-thin">
            <table className="w-full text-[13px]">
              <thead>
                <tr className="border-b border-border text-left text-2xs uppercase tracking-wide text-faint">
                  <th className="px-4 py-2 font-medium">When (UTC)</th>
                  <th className="px-4 py-2 font-medium">Actor</th>
                  <th className="px-4 py-2 font-medium">Action</th>
                  <th className="px-4 py-2 font-medium">Detail</th>
                  <th className="px-4 py-2 font-medium">IP</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {entries.map((e) => (
                  <tr key={e.id} className="hover:bg-surface-2/40">
                    <td className="whitespace-nowrap px-4 py-2 font-mono text-2xs text-faint">{stamp(e.createdAt)}</td>
                    <td className="px-4 py-2 text-muted">{e.actorEmail || "—"}</td>
                    <td className="px-4 py-2"><span className="rounded bg-surface-2 px-1.5 py-0.5 font-mono text-2xs">{e.action}</span></td>
                    <td className="max-w-[280px] truncate px-4 py-2 font-mono text-2xs text-faint" title={JSON.stringify(e.target)}>{e.target && Object.keys(e.target).length ? JSON.stringify(e.target) : "—"}</td>
                    <td className="px-4 py-2 font-mono text-2xs text-faint">{e.ip || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
