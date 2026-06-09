import { Suspense, type ReactNode } from "react";
import { Await } from "@remix-run/react";
import { Skeleton } from "~/components/ui";

/** Suspense + Await wrapper: streams the shell immediately, fills in when the
 *  deferred promise resolves, degrades per-panel on error. */
export function Deferred<T>({
  resolve,
  fallback,
  children,
}: {
  resolve: Promise<T>;
  fallback: ReactNode;
  children: (value: T) => ReactNode;
}) {
  return (
    <Suspense fallback={fallback}>
      {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
      <Await resolve={resolve as any} errorElement={<div className="px-4 py-10 text-center text-[13px] text-err">data source unavailable</div>}>
        {children as any}
      </Await>
    </Suspense>
  );
}

/** A few shimmer rows for table fallbacks. */
export function RowsSkeleton({ rows = 6, className }: { rows?: number; className?: string }) {
  return (
    <div className={"space-y-2 p-4 " + (className || "")}>
      {Array.from({ length: rows }).map((_, i) => (
        <Skeleton key={i} className="h-7 w-full" />
      ))}
    </div>
  );
}

export function ChartSkeleton({ height = 190 }: { height?: number }) {
  return (
    <div className="p-3" style={{ height: height + 24 }}>
      <div className="h-full w-full animate-pulse rounded bg-surface-2/60" />
    </div>
  );
}
