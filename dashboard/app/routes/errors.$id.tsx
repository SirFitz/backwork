import type { ActionFunctionArgs, LoaderFunctionArgs, MetaFunction } from "@remix-run/node";
import { json, redirect } from "@remix-run/node";
import { Form, useLoaderData, useNavigation } from "@remix-run/react";
import { Link } from "~/components/env-link";
import { ArrowLeft, Check, ChevronRight, EyeOff, RotateCcw } from "lucide-react";
import { Badge, Card, CardHead, Empty, PageTitle } from "~/components/ui";
import { requireOrg, requireRole } from "~/lib/auth/context.server";
import { assertSameOrigin } from "~/lib/auth/security.server";
import { getErrorGroup, recentEvents, setErrorStatus, type ErrStatus } from "~/lib/errors.server";
import { logAudit } from "~/lib/audit.server";
import { cn } from "~/lib/utils";
import { ErrorSourceLabel } from "~/components/error-source";
import { ErrorSource } from "~/lib/error-kinds";
import { readOccurrence } from "~/lib/error-occurrence";

export const meta: MetaFunction = () => [{ title: "Error · backwork" }];

export async function loader({ request, params }: LoaderFunctionArgs) {
  const ctx = await requireOrg(request);
  const group = await getErrorGroup(ctx.org.id, params.id!);
  if (!group) throw new Response("Not found", { status: 404 });
  const events = await recentEvents(ctx.org.id, group.id, 25);
  return json({ group, events, role: ctx.role });
}

export async function action({ request, params }: ActionFunctionArgs) {
  const ctx = await requireOrg(request);
  assertSameOrigin(request);
  requireRole(ctx, "member");
  const fd = await request.formData();
  const intent = String(fd.get("intent"));
  const map: Record<string, ErrStatus> = { resolve: "resolved", ignore: "ignored", reopen: "open" };
  const status = map[intent];
  if (!status) return json({ error: "Unknown action." }, { status: 400 });
  const n = await setErrorStatus(ctx.org.id, params.id!, status);
  if (!n) throw new Response("Not found", { status: 404 });
  void logAudit({ request, orgId: ctx.org.id, actorUserId: ctx.user.id, action: `error.${intent}`, target: { id: params.id } });
  return redirect(`/errors/${params.id}`);
}

function stamp(d: string | Date) {
  return new Date(d).toISOString().replace("T", " ").slice(0, 19) + "Z";
}

export default function ErrorDetail() {
  const { group: g, events, role } = useLoaderData<typeof loader>();
  const nav = useNavigation();
  const busy = nav.state !== "idle";
  const sample = (g.sample || {}) as Record<string, any>;
  const canAct = role === "owner" || role === "admin" || role === "member";
  const reported = g.source === ErrorSource.Reported;
  const view = readOccurrence(g.sample, reported);
  const stack = view.stack ?? "";
  const context = sample.context && Object.keys(sample.context).length ? sample.context : null;
  const traceId = view.traceId;
  // A request-derived group has no stack by nature (BAC-85); log-derived ones carry it since BAC-94.
  const hasStackCard = g.source !== ErrorSource.Request;
  const parsedMessage = view.errorMessage && view.errorMessage !== g.message ? view.errorMessage : null;
  const tone = g.level === "fatal" || g.level === "error" ? "err" : g.level === "warning" ? "warn" : "neutral";

  const Btn = ({ intent, label, icon: Icon }: { intent: string; label: string; icon: any }) => (
    <Form method="post">
      <input type="hidden" name="intent" value={intent} />
      <button type="submit" disabled={busy} className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-surface px-3 py-1.5 text-2xs font-medium text-fg hover:bg-surface-2 disabled:opacity-50">
        <Icon className="h-3.5 w-3.5" /> {label}
      </button>
    </Form>
  );

  return (
    <div className="space-y-5 animate-fade-in">
      <Link to="/errors" className="inline-flex items-center gap-1 text-2xs text-muted hover:text-fg"><ArrowLeft className="h-3.5 w-3.5" /> All errors</Link>

      <div data-content className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <Badge tone={tone}>{g.level}</Badge>
            <ErrorSourceLabel source={g.source} />
            {g.status !== "open" ? <Badge tone="neutral">{g.status}</Badge> : null}
            {g.project ? <span title="Environment (project)"><Badge tone="neutral">{g.project}</Badge></span> : null}
            <h1 className="truncate font-mono text-lg font-semibold text-fg">{g.type}</h1>
          </div>
          <p className="mt-1 break-words text-sm text-muted">{g.message || "—"}</p>
          {parsedMessage ? (
            <p data-error-message className="mt-1 break-words font-mono text-xs text-fg">{parsedMessage}</p>
          ) : null}
          {traceId ? (
            <Link to={`/requests/${traceId}`} className="mt-1 inline-flex items-center gap-1 text-2xs text-brand hover:underline">
              Latest request <span className="font-mono">{traceId}</span>
            </Link>
          ) : null}
        </div>
        {canAct ? (
          <div className="flex flex-wrap gap-2">
            {g.status !== "resolved" ? <Btn intent="resolve" label="Resolve" icon={Check} /> : null}
            {g.status !== "ignored" ? <Btn intent="ignore" label="Ignore" icon={EyeOff} /> : null}
            {g.status !== "open" ? <Btn intent="reopen" label="Reopen" icon={RotateCcw} /> : null}
          </div>
        ) : null}
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {[
          ["Events", String(g.count)],
          ["Service", g.service || "—"],
          ["Project", g.project || "—"],
          ["First seen", stamp(g.firstSeen)],
          ["Last seen", stamp(g.lastSeen)],
          ["Environment", view.environment ?? "—"],
        ].map(([k, v]) => (
          <div key={k} className="rounded-lg border border-border bg-surface px-3 py-2">
            <div className="text-2xs uppercase tracking-wide text-faint">{k}</div>
            <div className="mt-0.5 truncate font-mono text-xs text-fg" title={v}>{v}</div>
          </div>
        ))}
      </div>

      {hasStackCard ? (
      <Card>
        <CardHead title="Stack trace" sub={reported ? `fingerprint ${g.fingerprint}` : "latest occurrence"} />
        {stack ? (
          <pre data-stack className="scroll-thin max-h-[460px] overflow-auto px-4 py-3 font-mono text-2xs leading-relaxed text-muted">{stack}</pre>
        ) : (
          <Empty title="No stack trace">{reported ? "This error was reported without a stack trace." : "The latest log line of this error carried no stack trace."}</Empty>
        )}
      </Card>
      ) : null}

      {context ? (
        <Card>
          <CardHead title="Context" />
          <pre className="scroll-thin max-h-[320px] overflow-auto px-4 py-3 font-mono text-2xs leading-relaxed text-muted">{JSON.stringify(context, null, 2)}</pre>
        </Card>
      ) : null}

      <Card>
        <CardHead title="Recent occurrences" sub={`${events.length} shown`} />
        {events.length === 0 ? (
          <Empty title="No occurrences recorded" />
        ) : (
          <ul className="divide-y divide-border">
            {events.map((e) => {
              const o = readOccurrence(e.payload, reported);
              const text = o.errorMessage ?? o.message ?? "—";
              const link = o.traceId ? (
                <Link to={`/requests/${o.traceId}`} className="shrink-0 font-mono text-brand hover:underline">request</Link>
              ) : null;
              const row = (
                <>
                  <span className="shrink-0 font-mono text-faint">{stamp(e.createdAt)}</span>
                  <span className="min-w-0 flex-1 truncate text-muted" title={text}>{text}</span>
                </>
              );
              if (!o.stack) {
                return (
                  <li key={e.id} className="flex items-center justify-between gap-4 px-4 py-2 text-2xs">
                    {row}
                    {link}
                  </li>
                );
              }
              return (
                <li key={e.id} className="text-2xs">
                  <details data-occurrence className="group">
                    <summary className="flex cursor-pointer list-none items-center justify-between gap-4 px-4 py-2 hover:bg-surface-2/50 [&::-webkit-details-marker]:hidden">
                      <ChevronRight className="-ml-1 h-3.5 w-3.5 shrink-0 text-faint transition-transform group-open:rotate-90" aria-hidden />
                      {row}
                      {link}
                    </summary>
                    <div className="border-t border-border bg-surface-2/40 px-4 py-2">
                      {o.message && o.message !== text ? <p className="mb-1 break-words font-mono text-faint">{o.message}</p> : null}
                      <pre className="scroll-thin max-h-[320px] overflow-auto font-mono leading-relaxed text-muted">{o.stack}</pre>
                    </div>
                  </details>
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </div>
  );
}
