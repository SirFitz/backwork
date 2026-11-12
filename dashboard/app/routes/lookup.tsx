// Find a request by any ID (design 7.1, 8). GET /lookup?q=<input>
//  - a valid input redirects to /traces/<trace_id>;
//  - with &preview=1 it answers JSON for the header search (resolution and the request found);
//  - an invalid input is rejected with a message and never reaches a query.
import type { LoaderFunctionArgs, MetaFunction } from "@remix-run/node";
import { json, redirect } from "@remix-run/node";
import { Form, useLoaderData } from "@remix-run/react";
import { Search } from "lucide-react";
import { Card, PageTitle } from "~/components/ui";
import { requireOrg } from "~/lib/auth/context.server";
import { tenantOf } from "~/lib/tenant.server";
import { IdRule, toTraceId } from "~/lib/hops/id";
import { progressiveLookup, type WindowResult } from "~/lib/hops/query.server";
import { HOP_RETENTION_DAYS, WINDOW_LABEL } from "~/lib/hops/types";
import { buildRequestTree, requestSummary, type RequestSummary } from "~/lib/hops/tree";

export const meta: MetaFunction = () => [{ title: "Find a request · backwork.dev" }];

export type LookupPreview =
  | { ok: false; message: string }
  | {
      ok: true;
      traceId: string;
      rule: IdRule;
      input: string;
      found: boolean;
      /** e.g. "the last hour"; for a miss, how far back it searched. */
      searched: string;
      summary: RequestSummary | null;
      error: string | null;
    };

/** Where the request view lives for a resolved input. The original input is kept to show it beside the trace ID. */
function requestHref(traceId: string, rule: IdRule, input: string): string {
  return rule === IdRule.Hex ? `/traces/${traceId}` : `/traces/${traceId}?q=${encodeURIComponent(input)}`;
}

export async function loader({ request }: LoaderFunctionArgs) {
  const ctx = await requireOrg(request);
  const url = new URL(request.url);
  const q = url.searchParams.get("q") ?? "";
  const preview = url.searchParams.get("preview") === "1";
  const resolved = toTraceId(q);

  if (!resolved.ok) {
    const body: LookupPreview = { ok: false, message: resolved.message };
    return json({ preview: body, q }, { status: preview ? 200 : 400 });
  }
  if (!preview) throw redirect(requestHref(resolved.traceId, resolved.rule, resolved.input));

  const now = Date.now();
  let result: WindowResult | null = null;
  let error: string | null = null;
  try {
    result = await progressiveLookup(resolved.traceId, tenantOf(ctx.org.id), now).retention;
  } catch (e) {
    error = e instanceof Error ? e.message.slice(0, 160) : "lookup failed";
  }
  const summary = result?.found ? requestSummary(buildRequestTree(result.records, [], [], now, result.links)) : null;
  const body: LookupPreview = {
    ok: true,
    traceId: resolved.traceId,
    rule: resolved.rule,
    input: resolved.input,
    found: Boolean(result?.found),
    searched: result ? WINDOW_LABEL[result.window] : `the last ${HOP_RETENTION_DAYS} days`,
    summary,
    error,
  };
  return json({ preview: body, q }, { headers: { "Cache-Control": "no-store" } });
}

export default function Lookup() {
  const { preview, q } = useLoaderData<typeof loader>();
  return (
    <div className="space-y-4 animate-fade-in">
      <PageTitle title="Find a request" sub="Paste a trace ID, a request ID, a UUID or a full traceparent." />
      <Card className="p-4">
        <Form method="get" action="/lookup" className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-[240px] flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-faint" />
            <input
              name="q"
              defaultValue={q}
              autoFocus
              aria-label="Trace ID or request ID"
              className="h-9 w-full rounded-lg border border-border bg-surface pl-9 pr-3 font-mono text-[13px] outline-none focus:border-brand/40"
            />
          </div>
          <button className="h-9 rounded-lg border border-border bg-surface px-3 text-[13px] font-medium hover:bg-surface-2">Open</button>
        </Form>
        {!preview.ok ? <p role="alert" className="mt-3 text-[13px] text-err">{preview.message}</p> : null}
      </Card>
    </div>
  );
}
