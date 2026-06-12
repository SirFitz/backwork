import type { LoaderFunctionArgs, MetaFunction } from "@remix-run/node";
import { json } from "@remix-run/node";
import { Form, useLoaderData, useNavigate, useSubmit } from "@remix-run/react";
import { Bug } from "lucide-react";
import { Badge, Card, CardHead, Empty, PageTitle } from "~/components/ui";
import { requireOrg } from "~/lib/auth/context.server";
import { listErrorGroups, errorStatusCounts, errorServices } from "~/lib/errors.server";
import { cn, timeAgo } from "~/lib/utils";

export const meta: MetaFunction = () => [{ title: "Errors · backwork" }];

const STATUSES = ["open", "resolved", "ignored", "all"] as const;

export async function loader({ request }: LoaderFunctionArgs) {
  const ctx = await requireOrg(request);
  const url = new URL(request.url);
  const status = url.searchParams.get("status") || "open";
  const service = url.searchParams.get("service") || "all";
  const [groups, counts, services] = await Promise.all([
    listErrorGroups(ctx.org.id, { status, service, limit: 100 }),
    errorStatusCounts(ctx.org.id),
    errorServices(ctx.org.id),
  ]);
  return json({ groups, counts, services, status, service });
}

function levelTone(l: string): "err" | "warn" | "neutral" {
  return l === "fatal" || l === "error" ? "err" : l === "warning" ? "warn" : "neutral";
}

export default function Errors() {
  const d = useLoaderData<typeof loader>();
  const submit = useSubmit();
  const navigate = useNavigate();

  return (
    <div className="space-y-5 animate-fade-in">
      <PageTitle title="Errors" sub="Exceptions reported by your services, grouped by fingerprint — newest activity first. Resolve a group and it reopens automatically if it happens again." />

      <div className="flex flex-wrap items-center gap-2">
        <div className="inline-flex rounded-lg border border-border bg-surface p-0.5 text-2xs">
          {STATUSES.map((s) => (
            <a
              key={s}
              href={`/errors?status=${s}${d.service !== "all" ? `&service=${encodeURIComponent(d.service)}` : ""}`}
              className={cn("rounded-md px-2.5 py-1.5 font-medium capitalize transition-colors", d.status === s ? "bg-surface-2 text-fg" : "text-muted hover:text-fg")}
            >
              {s} <span className="text-faint">{d.counts[s] ?? 0}</span>
            </a>
          ))}
        </div>
        {d.services.length ? (
          <Form method="get" className="flex flex-wrap items-center gap-2">
            <input type="hidden" name="status" value={d.status} />
            <select name="service" defaultValue={d.service} onChange={(e) => submit(e.currentTarget.form)} className="h-9 rounded-lg border border-border bg-surface px-3 text-[13px] outline-none focus:border-brand/40">
              <option value="all">all services</option>
              {d.services.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </Form>
        ) : null}
      </div>

      <Card>
        <CardHead title="Error groups" sub={`${d.groups.length} group${d.groups.length === 1 ? "" : "s"}`} right={<Badge tone="neutral">{d.counts.open ?? 0} open</Badge>} />
        {d.groups.length === 0 ? (
          <Empty icon={<Bug className="h-5 w-5" />} title="No errors here">
            {d.status === "open"
              ? "No open errors — nice. Report exceptions by POSTing them to /ingest/errors with your project token (see Projects for the snippet)."
              : `No ${d.status} errors.`}
          </Empty>
        ) : (
          <div className="overflow-x-auto scroll-thin">
            <table className="w-full text-[13px]">
              <thead>
                <tr className="border-b border-border text-left text-2xs uppercase tracking-wide text-faint">
                  <th className="px-4 py-2 font-medium">Error</th>
                  <th className="px-4 py-2 font-medium">Service</th>
                  <th className="px-4 py-2 text-right font-medium">Events</th>
                  <th className="px-4 py-2 text-right font-medium">Last seen</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {d.groups.map((g) => (
                  <tr key={g.id} onClick={() => navigate(`/errors/${g.id}`)} className="cursor-pointer hover:bg-surface-2/50">
                    <td className="max-w-[520px] px-4 py-2.5">
                      <div className="flex items-center gap-2">
                        <Badge tone={levelTone(g.level)}>{g.level}</Badge>
                        <span className="font-mono text-xs font-semibold text-fg">{g.type}</span>
                        {g.status !== "open" ? <Badge tone="neutral">{g.status}</Badge> : null}
                      </div>
                      <div className="mt-0.5 truncate text-2xs text-muted" title={g.message}>{g.message || "—"}</div>
                    </td>
                    <td className="px-4 py-2.5 text-2xs text-accent">{g.service || "—"}</td>
                    <td className="px-4 py-2.5 text-right font-mono tabular-nums text-muted">{g.count}</td>
                    <td className="px-4 py-2.5 text-right text-2xs text-faint">{timeAgo(new Date(g.lastSeen).getTime())}</td>
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
