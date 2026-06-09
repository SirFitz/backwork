import type { LinksFunction, MetaFunction } from "@remix-run/node";
import {
  Links,
  Meta,
  NavLink,
  Outlet,
  Scripts,
  ScrollRestoration,
  useRevalidator,
} from "@remix-run/react";
import { useEffect, useState } from "react";
import {
  Activity,
  AlertTriangle,
  BellRing,
  GitBranch,
  LayoutDashboard,
  ScrollText,
} from "lucide-react";
import tailwind from "~/tailwind.css?url";
import { cn } from "~/lib/utils";

export const links: LinksFunction = () => [{ rel: "stylesheet", href: tailwind }];

export const meta: MetaFunction = () => [
  { title: "backwork.dev — logs & APM" },
  { name: "description", content: "Self-hosted log aggregation and application performance monitoring." },
];

const NAV = [
  { to: "/", label: "Overview", icon: LayoutDashboard, end: true },
  { to: "/logs", label: "Logs", icon: ScrollText },
  { to: "/metrics", label: "Metrics", icon: Activity },
  { to: "/traces", label: "Traces", icon: GitBranch },
  { to: "/incidents", label: "Incidents", icon: AlertTriangle },
  { to: "/alerts", label: "Alerts", icon: BellRing },
];

function LiveClock() {
  const revalidator = useRevalidator();
  const [last, setLast] = useState<number>(Date.now());
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    if (paused) return;
    const id = setInterval(() => {
      if (document.visibilityState === "visible") revalidator.revalidate();
    }, 10000);
    return () => clearInterval(id);
  }, [revalidator, paused]);

  useEffect(() => {
    if (revalidator.state === "idle") setLast(Date.now());
  }, [revalidator.state]);

  return (
    <div className="flex items-center gap-3 text-xs text-muted">
      <button
        onClick={() => setPaused((p) => !p)}
        className="flex items-center gap-1.5 rounded border border-border px-2 py-1 hover:bg-panel-2"
        title={paused ? "Resume live updates" : "Pause live updates"}
      >
        <span className={cn("h-1.5 w-1.5 rounded-full", paused ? "bg-muted" : "bg-ok animate-[pulse_1.5s_ease-in-out_infinite]")} />
        {paused ? "Paused" : "Live"}
      </button>
      <span className="tabular-nums">
        {revalidator.state !== "idle" ? "refreshing…" : "updated " + new Date(last).toLocaleTimeString("en-GB", { hour12: false })}
      </span>
    </div>
  );
}

export function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <Meta />
        <Links />
      </head>
      <body className="min-h-screen bg-bg text-fg">
        {children}
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export default function App() {
  return (
    <div className="flex min-h-screen">
      <aside className="fixed inset-y-0 left-0 flex w-56 flex-col border-r border-border bg-panel">
        <div className="flex items-center gap-2 px-5 py-4">
          <div className="grid h-7 w-7 place-items-center rounded bg-brand font-mono text-sm font-bold text-bg">b</div>
          <div className="font-semibold tracking-tight">
            backwork<span className="text-brand">.dev</span>
          </div>
        </div>
        <nav className="mt-2 flex flex-1 flex-col gap-0.5 px-3">
          {NAV.map((n) => (
            <NavLink
              key={n.to}
              to={n.to}
              end={n.end}
              className={({ isActive }) =>
                cn(
                  "flex items-center gap-2.5 rounded-md px-3 py-2 text-sm transition-colors",
                  isActive ? "bg-brand/10 text-brand" : "text-muted hover:bg-panel-2 hover:text-fg"
                )
              }
            >
              <n.icon className="h-4 w-4" />
              {n.label}
            </NavLink>
          ))}
        </nav>
        <div className="px-5 py-4 text-[11px] leading-relaxed text-muted">
          <div className="mb-1 flex items-center gap-1.5">
            <span className="h-1.5 w-1.5 rounded-full bg-ok" /> Loki · VictoriaMetrics · Jaeger
          </div>
          self-hosted · &lt;$50/mo
        </div>
      </aside>

      <main className="ml-56 flex-1">
        <header className="sticky top-0 z-10 flex h-14 items-center justify-between border-b border-border bg-bg/80 px-6 backdrop-blur">
          <div className="text-sm text-muted">Log Aggregation &amp; APM</div>
          <LiveClock />
        </header>
        <div className="p-6">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
