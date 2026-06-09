import type { ReactNode } from "react";

export const AUTH_FIELD =
  "h-10 w-full rounded-lg border border-border bg-surface px-3 text-[14px] outline-none placeholder:text-faint focus:border-brand/50";

export function AuthCard({ title, sub, children, footer }: { title: string; sub?: string; children: ReactNode; footer?: ReactNode }) {
  return (
    <div className="grid min-h-screen place-items-center bg-bg px-4">
      <div className="w-full max-w-sm animate-fade-in">
        <div className="mb-6 flex items-center justify-center gap-2.5">
          <span className="grid h-8 w-8 place-items-center rounded-md bg-brand font-mono text-sm font-bold text-brand-fg">b</span>
          <span className="text-lg font-semibold tracking-tight">backwork<span className="text-brand">.dev</span></span>
        </div>
        <div className="rounded-xl border border-border bg-surface p-6">
          <h1 className="text-base font-semibold">{title}</h1>
          {sub ? <p className="mt-1 text-[13px] text-muted">{sub}</p> : null}
          <div className="mt-5">{children}</div>
        </div>
        {footer ? <div className="mt-4 text-center text-[13px] text-muted">{footer}</div> : null}
      </div>
    </div>
  );
}
