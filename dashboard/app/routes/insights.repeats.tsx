// Insights > Repeated calls (BAC-68): the queries that most often run many times inside one request,
// over the last 15 minutes. The page renders at once; the scan streams in with its own skeleton
// and error state, and is served from a stale-while-revalidate cache.
import type { LoaderFunctionArgs, MetaFunction } from "@remix-run/node";
import { defer } from "@remix-run/node";
import { Link, useLoaderData } from "@remix-run/react";
import { Repeat } from "lucide-react";
import { Card, CardHead, Empty } from "~/components/ui";
import { Deferred, RowsSkeleton } from "~/components/defer";
import { NUM, TD, Th } from "~/components/services-table";
import { requireOrg } from "~/lib/auth/context.server";
import { tenantOf } from "~/lib/tenant.server";
import { REPEATS_WINDOW_MS, scanRepeats } from "~/lib/hops/repeats.server";
import type { RepeatRow, RepeatScan } from "~/lib/hops/repeats.server";
import { shapeLabel } from "~/lib/hops/stmt-shape";
import { fmtUs } from "~/lib/hops/time-format";
import { cn } from "~/lib/utils";

export const meta: MetaFunction = () => [{ title: "Repeated calls · Insights · backwork" }];

type Settled<T> = { ok: true; value: T } | { ok: false; error: string };

function settle<T>(p: Promise<T>): Promise<Settled<T>> {
  return p.then(
    (value): Settled<T> => ({ ok: true, value }),
    (e: unknown): Settled<T> => ({ ok: false, error: e instanceof Error ? e.message.slice(0, 160) : "unavailable" }),
  );
}

export async function loader({ request }: LoaderFunctionArgs) {
  const ctx = await requireOrg(request);
  return defer({ windowMinutes: REPEATS_WINDOW_MS / 60_000, scan: settle(scanRepeats(tenantOf(ctx.org.id))) });
}

function windowWords(minutes: number): string {
  return `the last ${minutes} minutes`;
}

export default function RepeatedCalls() {
  const d = useLoaderData<typeof loader>();
  const words = windowWords(d.windowMinutes);
  return (
    <Card>
      <CardHead title="Repeated queries" sub={`Inside one request, ${words}`} />
      <Deferred resolve={d.scan} fallback={<RowsSkeleton rows={5} />}>
        {(s: Settled<RepeatScan>) => (s.ok ? <ScanBody scan={s.value} words={words} /> : <ScanFailed error={s.error} />)}
      </Deferred>
    </Card>
  );
}

function ScanFailed({ error }: { error: string }) {
  return <p className="px-4 py-10 text-center text-[13px] text-err">Request records unavailable: {error}. Reload to try again.</p>;
}

function ScanBody({ scan, words }: { scan: RepeatScan; words: string }) {
  if (scan.statementsOff) {
    return (
      <Empty icon={<Repeat className="h-5 w-5" />} title="Query text is switched off for this organisation, so repeats cannot be matched.">
        Cache repeats are still shown inside each request.
      </Empty>
    );
  }
  if (!scan.rows.length) return <Empty icon={<Repeat className="h-5 w-5" />} title={`No repeated queries in ${words}.`} />;
  return (
    <>
      <div className="overflow-x-auto scroll-thin">
        <table className="w-full border-collapse text-[13px]">
          <thead>
            <tr>
              <Th>Query</Th>
              <Th className="hidden md:table-cell">Service</Th>
              <Th num><span className="sm:hidden">Repeats</span><span className="hidden sm:inline">Per request</span></Th>
              <Th num className="hidden sm:table-cell">Requests</Th>
              <Th num>Time wasted</Th>
              <Th num>Example</Th>
            </tr>
          </thead>
          <tbody>
            {scan.rows.map((r) => <Row key={`${r.service}|${r.shapeId}|${r.table ?? ""}`} row={r} />)}
          </tbody>
        </table>
      </div>
      {scan.truncated ? (
        <p className="px-4 py-2 text-2xs text-faint">Sampled: the last {scan.recordsRead.toLocaleString("en-GB")} records of {words}.</p>
      ) : null}
    </>
  );
}

function Row({ row }: { row: RepeatRow }) {
  const together = row.requests - row.sequentialRequests;
  const how = together === 0 ? "one after another" : row.sequentialRequests === 0 ? "together" : `one after another in ${row.sequentialRequests} of ${row.requests} requests`;
  return (
    <tr className="hover:bg-surface-2/60">
      {/* takes the rest of the row and truncates (max-w-0), so the table never scrolls sideways */}
      <td className={cn(TD, "w-full max-w-0")}>
        <div className="flex min-w-0 items-baseline gap-2">
          <span className="shrink-0 font-mono text-[12.5px] font-medium">{row.label}</span>
          <span className="min-w-0 truncate font-mono text-[12px] text-faint" title={row.shape}>{shapeLabel(row.shape)}</span>
        </div>
        <div className="truncate text-2xs text-faint md:hidden">{row.service}</div>
      </td>
      <td className={cn(TD, "hidden md:table-cell")}>{row.service}</td>
      <td className={cn(TD, NUM)} title={`median of ${row.requests} ${row.requests === 1 ? "request" : "requests"}, ${how}`}>{formatCount(row.medianRepeats)}</td>
      <td className={cn(TD, NUM, "hidden sm:table-cell")}>{row.requests.toLocaleString("en-GB")}</td>
      <td className={cn(TD, NUM)} title={`${fmtUs(row.totalUs)} in all`}>{fmtUs(row.wastedUs)}</td>
      <td className={cn(TD, "text-right")}>
        <Link to={`/requests/${row.exampleTraceId}`} prefetch="intent" className="font-sans text-2xs font-medium text-brand hover:underline">Open</Link>
      </td>
    </tr>
  );
}

function formatCount(n: number): string {
  return Number.isInteger(n) ? `×${n}` : `×${n.toFixed(1)}`;
}
