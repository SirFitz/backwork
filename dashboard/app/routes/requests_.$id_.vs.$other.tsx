// Two requests side by side (BAC-75, insights plan 08): `/requests/:id/vs/:other`, where `other`
// is a trace ID or `typical` (a typical request of the same route from the last hour). The page
// returns at once; each trace is looked up on its own and settles to its own value or error, and
// the comparison is built in the browser from both (`diffRequests`, pure).
import type { LoaderFunctionArgs, MetaFunction } from "@remix-run/node";
import { defer } from "@remix-run/node";
import { Link, useLoaderData, useNavigate } from "@remix-run/react";
import { useMemo, useState, type FormEvent, type ReactNode } from "react";
import { ArrowLeft } from "lucide-react";
import { Badge, Card, PageTitle, Skeleton } from "~/components/ui";
import { Deferred, RowsSkeleton } from "~/components/defer";
import { Clock } from "~/components/time";
import { DiffTable, TopDiffs, type DiffFocus } from "~/components/insights/diff-table";
import { requireOrg } from "~/lib/auth/context.server";
import { tenantOf } from "~/lib/tenant.server";
import { progressiveLookup } from "~/lib/hops/query.server";
import { typicalRequest, type TypicalPick } from "~/lib/hops/typical.server";
import { splitRequests } from "~/lib/hops/split";
import { buildRequestTree, headHop, isFailed, requestSummary } from "~/lib/hops/tree";
import { CHOSEN_OTHER_NAME, DEFAULT_OTHER_NAME, NO_TYPICAL_SENTENCE, TYPICAL_PARAM, diffRequests } from "~/lib/hops/diff";
import { fmtUs } from "~/lib/hops/time-format";
import { HopState, Via, type HopRecord, type LinkedId, type RequestTree, type TraceId } from "~/lib/hops/types";

export const meta: MetaFunction = () => [{ title: "Compare requests · backwork.dev" }];

/** A trace ID from a path or a pasted value: up to 32 hex, padded to 32; null otherwise. */
function traceIdFrom(raw: string | null | undefined): TraceId | null {
  const text = (raw ?? "").trim().toLowerCase();
  if (!text || text.length > 32 || !/^[0-9a-f]+$/.test(text)) return null;
  const id = text.padStart(32, "0");
  return /^0+$/.test(id) ? null : (id as TraceId);
}

/** One trace's records as the page needs them. */
interface SideRecords {
  traceId: TraceId;
  records: HopRecord[];
  links: LinkedId[];
  /** The window hit the fetch limit: the comparison says so. */
  truncated: boolean;
}

type Settled<T> = { ok: true; value: T } | { ok: false; error: string };

function settle<T>(p: Promise<T>): Promise<Settled<T>> {
  return p.then(
    (value): Settled<T> => ({ ok: true, value }),
    (e: unknown): Settled<T> => ({ ok: false, error: e instanceof Error ? e.message.slice(0, 160) : "unavailable" }),
  );
}

/** The first request of a trace (a trace can hold several, `splitRequests`), as a tree. */
function firstTree(side: SideRecords, now: number): RequestTree {
  const part = splitRequests(side.records, [], side.links)[0];
  return buildRequestTree(part.records, [], now, part.links, null);
}

export async function loader({ request, params }: LoaderFunctionArgs) {
  const ctx = await requireOrg(request);
  const tenant = tenantOf(ctx.org.id);
  const a = traceIdFrom(params.id);
  const typical = params.other === TYPICAL_PARAM;
  const chosen = typical ? null : traceIdFrom(params.other);
  if (!a || (!typical && !chosen)) throw new Response("Not a trace ID", { status: 404 });
  const now = Date.now();

  const lookup = (traceId: TraceId): Promise<SideRecords | null> =>
    progressiveLookup(traceId, tenant, now).retention.then((r) => (r.found ? { traceId, records: r.records, links: r.links, truncated: r.truncated } : null));

  const aSide = lookup(a);
  const pick: Promise<TypicalPick | null> = typical
    ? aSide.then((s) => {
        const summary = s ? requestSummary(firstTree(s, now)) : null;
        if (!summary || summary.via !== Via.Http) return null;
        return typicalRequest(tenant, summary, now);
      })
    : Promise.resolve({ traceId: chosen as TraceId, durationMs: 0 });
  const bSide = pick.then((p) => (p ? lookup(p.traceId as TraceId) : null));
  return defer({ a, typical, now, aSide: settle(aSide), pick: settle(pick), bSide: settle(bSide) });
}

// ---------------------------------------------------------------- the page

type Data = ReturnType<typeof useLoaderData<typeof loader>>;

export default function ComparePage() {
  const d = useLoaderData<typeof loader>();
  const bName = d.typical ? "Typical request" : "Other request";
  return (
    <div className="animate-fade-in">
      <Link to={`/requests/${d.a}`} className="mb-2 inline-flex items-center gap-1.5 text-[13px] text-muted hover:text-fg">
        <ArrowLeft className="h-[15px] w-[15px]" /> Request
      </Link>
      <PageTitle
        title="Compare requests"
        sub="This request beside a typical one of the same route from the last hour, or beside any request you paste. Calls line up by what they are, not by their IDs."
        right={<PasteForm a={d.a} typical={d.typical} />}
      />
      <Card className="mb-4 mt-3">
        <div className="grid divide-y divide-border md:grid-cols-2 md:divide-x md:divide-y-0">
          <Deferred resolve={d.aSide} fallback={<SideSkeleton title="This request" />}>
            {(s: Settled<SideRecords | null>) => <SideColumn title="This request" settled={s} now={d.now} />}
          </Deferred>
          <Deferred resolve={d.pick} fallback={<SideSkeleton title={bName} note={d.typical ? "Finding a typical request of this route…" : undefined} />}>
            {(p: Settled<TypicalPick | null>) => !p.ok ? <SideError title={bName} error={p.error} /> : !p.value ? <SideEmpty title={bName} text={NO_TYPICAL_SENTENCE} /> : (
              <Deferred resolve={d.bSide} fallback={<SideSkeleton title={bName} />}>
                {(s: Settled<SideRecords | null>) => <SideColumn title={bName} settled={s} now={d.now} />}
              </Deferred>
            )}
          </Deferred>
        </div>
      </Card>
      <Comparison d={d} bName={bName} />
    </div>
  );
}

/** Paste a request or trace ID to compare with; or go back to the typical one. */
function PasteForm({ a, typical }: { a: string; typical: boolean }) {
  const navigate = useNavigate();
  const [value, setValue] = useState("");
  const [bad, setBad] = useState(false);
  const submit = (e: FormEvent<HTMLFormElement>): void => {
    e.preventDefault();
    const id = traceIdFrom(value);
    setBad(id === null);
    if (id) navigate(`/requests/${a}/vs/${id}`);
  };
  return (
    <form onSubmit={submit} className="flex min-w-0 flex-wrap items-center gap-2">
      {!typical ? <Link to={`/requests/${a}/vs/${TYPICAL_PARAM}`} className="text-xs text-muted hover:text-fg hover:underline">Typical request</Link> : null}
      <input
        value={value}
        onChange={(e) => { setValue(e.target.value); setBad(false); }}
        placeholder="Trace ID to compare with"
        aria-label="Trace ID to compare with"
        aria-invalid={bad}
        className={`h-8 w-[min(280px,100%)] min-w-0 rounded-md border bg-bg px-2.5 font-mono text-xs ${bad ? "border-warn" : "border-border"}`}
      />
      <button type="submit" className="h-8 rounded-md border border-border px-3 text-xs text-fg hover:bg-surface-2">Compare</button>
      {bad ? <span className="w-full text-right text-2xs text-warn">Not a trace ID: up to 32 hex characters.</span> : null}
    </form>
  );
}

// ---------------------------------------------------------------- one side

function SideFrame({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="min-w-0 px-4 py-3">
      <div className="mb-1.5 text-2xs uppercase tracking-wide text-faint">{title}</div>
      {children}
    </div>
  );
}

function SideSkeleton({ title, note }: { title: string; note?: string }) {
  return (
    <SideFrame title={title}>
      <Skeleton className="mb-2 h-5 w-64 max-w-full animate-pulse" />
      <Skeleton className="h-4 w-80 max-w-full animate-pulse" />
      {note ? <p className="m-0 mt-2 text-2xs text-faint" role="status">{note}</p> : null}
    </SideFrame>
  );
}

function SideError({ title, error }: { title: string; error: string }) {
  return (
    <SideFrame title={title}>
      <p className="m-0 text-[13px] text-err">Hop records unavailable: the log store did not answer ({error}).</p>
    </SideFrame>
  );
}

function SideEmpty({ title, text }: { title: string; text: string }) {
  return (
    <SideFrame title={title}>
      <p className="m-0 text-[13px] text-muted">{text} Paste a trace ID above to compare with one you choose.</p>
    </SideFrame>
  );
}

function statusTone(status: number | null, failed: boolean): "ok" | "warn" | "err" | "neutral" {
  if (failed || (status !== null && status >= 500)) return "err";
  if (status !== null && status >= 400) return "warn";
  return status !== null ? "ok" : "neutral";
}

function SideColumn({ title, settled, now }: { title: string; settled: Settled<SideRecords | null>; now: number }) {
  if (!settled.ok) return <SideError title={title} error={settled.error} />;
  if (!settled.value) return <SideEmpty title={title} text="Not found: no hop records for this ID in the last 30 days." />;
  return <SideFacts title={title} side={settled.value} now={now} />;
}

function SideFacts({ title, side, now }: { title: string; side: SideRecords; now: number }) {
  const tree = useMemo(() => firstTree(side, now), [side, now]);
  const head = headHop(tree);
  if (!head) return <SideEmpty title={title} text="These records hold no request to compare." />;
  const fact = "whitespace-nowrap";
  return (
    <SideFrame title={title}>
      <div className="flex min-w-0 flex-wrap items-center gap-2 font-mono text-[14px] font-semibold">
        <span className="min-w-0 [overflow-wrap:anywhere]">
          {head.method ? <span className="font-medium text-faint">{head.method} </span> : null}
          {head.path ?? head.op ?? head.service}
        </span>
        <Badge tone={statusTone(head.status, isFailed(head))}>{head.status ?? (head.state === HopState.Finished ? "ok" : "open")}</Badge>
      </div>
      <div className="mt-1.5 flex flex-wrap gap-x-[18px] gap-y-1 text-[12.5px] text-muted">
        <span className={fact}>Started <span className="font-mono font-medium text-fg"><Clock ts={head.startMs} /></span></span>
        <span className={fact}>Took <span className="font-mono font-medium text-fg">{head.durationUs !== null ? fmtUs(head.durationUs) : "still running"}</span></span>
        <span className="min-w-0 [overflow-wrap:anywhere]" title={tree.services.join(", ")}>
          <b className="font-medium text-fg">{tree.services.length}</b> {tree.services.length === 1 ? "service" : "services"}: {tree.services.join(", ")}
        </span>
      </div>
      <Link to={`/requests/${side.traceId}`} className="mt-1 block truncate font-mono text-[11.5px] text-faint hover:text-fg hover:underline">{side.traceId}</Link>
    </SideFrame>
  );
}

// ---------------------------------------------------------------- the comparison

function ComparisonSkeleton() {
  return (
    <>
      <div className="mb-4 space-y-2">
        <Skeleton className="h-4 w-[36rem] max-w-full animate-pulse" />
        <Skeleton className="h-4 w-[28rem] max-w-full animate-pulse" />
      </div>
      <Card><RowsSkeleton rows={6} /></Card>
    </>
  );
}

/** Waits for both sides; a side that failed or was not found leaves this part empty (its column says why). */
function Comparison({ d, bName }: { d: Data; bName: string }) {
  return (
    <Deferred resolve={d.aSide} fallback={<ComparisonSkeleton />}>
      {(a: Settled<SideRecords | null>) => (
        <Deferred resolve={d.bSide} fallback={<ComparisonSkeleton />}>
          {(b: Settled<SideRecords | null>) => a.ok && a.value && b.ok && b.value
            ? <Diff a={a.value} b={b.value} now={d.now} typical={d.typical} bName={bName} />
            : null}
        </Deferred>
      )}
    </Deferred>
  );
}

function Diff({ a, b, now, typical, bName }: { a: SideRecords; b: SideRecords; now: number; typical: boolean; bName: string }) {
  const diff = useMemo(
    () => diffRequests(firstTree(a, now), firstTree(b, now), { aTruncated: a.truncated, bTruncated: b.truncated, otherName: typical ? DEFAULT_OTHER_NAME : CHOSEN_OTHER_NAME }),
    [a, b, now, typical],
  );
  const [focus, setFocus] = useState<DiffFocus | null>(null);
  return (
    <>
      <div className="mb-4 space-y-1 text-[13.5px] leading-[20px] text-fg" data-diff-lead>
        {diff.sentences.map((s) => <p key={s} className="m-0">{s}</p>)}
        {diff.warnings.map((w) => <p key={w} className="m-0 text-xs text-muted">{w}</p>)}
      </div>
      <TopDiffs rows={diff.top} onShow={(id) => setFocus((f) => ({ id, seq: (f?.seq ?? 0) + 1 }))} />
      <DiffTable rows={diff.rows} focus={focus} aName="This request" bName={bName} />
    </>
  );
}
