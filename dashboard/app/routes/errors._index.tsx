import type { LoaderFunctionArgs, MetaFunction } from "@remix-run/node";
import { json } from "@remix-run/node";
import { Form, useLoaderData, useSubmit } from "@remix-run/react";
import { EnvField, useCurrentEnv, useEnvNavigate } from "~/components/env-link";
import { withEnv } from "~/lib/env";
import { Bug } from "lucide-react";
import { Badge, Card, CardHead, Empty, PageTitle } from "~/components/ui";
import { requireScope } from "~/lib/env.server";
import { listErrorGroups, errorStatusCounts, errorServices } from "~/lib/errors.server";
import { cn } from "~/lib/utils";
import { Ago } from "~/components/time";
import { ErrorSourceLabel } from "~/components/error-source";

export const meta: MetaFunction = () => [{ title: "Errors · backwork" }];

const STATUSES = ["open", "resolved", "ignored", "all"] as const;
const FILTER_SELECT = "h-8 rounded-lg border border-border bg-surface px-3 text-[13px] outline-none focus:border-brand/40";

export async function loader({ request }: LoaderFunctionArgs) {
  const { ctx, env } = await requireScope(request);
  const url = new URL(request.url);
  const status = url.searchParams.get("status") || "open";
  const service = url.searchParams.get("service") || "all";
  // Groups are per project (BAC-89): only the chosen environment's.
  const [groups, counts, services] = await Promise.all([
    listErrorGroups(ctx.org.id, { status, service, project: env, limit: 100 }),
    errorStatusCounts(ctx.org.id, env),
    errorServices(ctx.org.id, env),
  ]);
  return json({ groups, counts, services, status, service });
}

function levelTone(l: string): "err" | "warn" | "neutral" {
  return l === "fatal" || l === "error" ? "err" : l === "warning" ? "warn" : "neutral";
}

export default function Errors() {
  const d = useLoaderData<typeof loader>();
  const submit = useSubmit();
  const navigate = useEnvNavigate();
  const env = useCurrentEnv();

  return (
    <div className="space-y-5 animate-fade-in">
      <PageTitle
        title="Errors"
        sub="Error-level log lines, failed requests and reported exceptions, grouped so repeats of one failure are one group. Newest activity first; a resolved group reopens if it happens again."
        right={
          <>
            {/* phone: status and service as two selects so the header stays one row */}
            <Form method="get" className="flex min-w-0 items-center gap-2 md:hidden">
              <EnvField />
              <select name="status" aria-label="Status" defaultValue={d.status} onChange={(e) => submit(e.currentTarget.form)} className={cn(FILTER_SELECT, "capitalize")}>
                {STATUSES.map((s) => <option key={s} value={s}>{s} {d.counts[s] ?? 0}</option>)}
              </select>
              {d.services.length ? (
                <select name="service" aria-label="Service" defaultValue={d.service} onChange={(e) => submit(e.currentTarget.form)} className={cn(FILTER_SELECT, "min-w-0 max-w-[150px]")}>
                  <option value="all">all services</option>
                  {d.services.map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
              ) : null}
            </Form>
            <div className="hidden h-8 items-center rounded-lg border border-border bg-surface p-0.5 text-2xs md:inline-flex">
              {STATUSES.map((s) => (
                <a
                  key={s}
                  href={withEnv(`/errors?status=${s}${d.service !== "all" ? `&service=${encodeURIComponent(d.service)}` : ""}`, env)}
                  className={cn("rounded-md px-2 py-1 font-medium capitalize transition-colors", d.status === s ? "bg-surface-2 text-fg" : "text-muted hover:text-fg")}
                >
                  {s} <span className="text-faint">{d.counts[s] ?? 0}</span>
                </a>
              ))}
            </div>
            {d.services.length ? (
              <Form method="get" className="hidden min-w-0 items-center gap-2 md:flex">
                <input type="hidden" name="status" value={d.status} />
                <EnvField />
                <select name="service" defaultValue={d.service} onChange={(e) => submit(e.currentTarget.form)} className={FILTER_SELECT}>
                  <option value="all">all services</option>
                  {d.services.map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
              </Form>
            ) : null}
          </>
        }
      />

      <Card>
        <CardHead title="Error groups" sub={`${d.groups.length} group${d.groups.length === 1 ? "" : "s"}`} right={<Badge tone="neutral">{d.counts.open ?? 0} open</Badge>} />
        {d.groups.length === 0 ? (
          <Empty icon={<Bug className="h-5 w-5" />} title="No errors here">
            {d.status === "open"
              ? "No open errors. Groups appear here from error-level log lines, requests that end with a 5xx status, and exceptions your services POST to /ingest/errors with their project token (see Projects for the snippet)."
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
                        <ErrorSourceLabel source={g.source} />
                        {g.status !== "open" ? <Badge tone="neutral">{g.status}</Badge> : null}
                      </div>
                      <div className="mt-0.5 truncate text-2xs text-muted" title={g.message}>{g.message || "—"}</div>
                    </td>
                    <td className="px-4 py-2.5 text-2xs text-accent">{g.service || "—"}</td>
                    <td className="px-4 py-2.5 text-right font-mono tabular-nums text-muted">{g.count}</td>
                    <td className="px-4 py-2.5 text-right text-2xs text-faint"><Ago ts={new Date(g.lastSeen).getTime()} /></td>
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
