import type { LinksFunction, LoaderFunctionArgs, MetaFunction } from "@remix-run/node";
import { json } from "@remix-run/node";
import {
  Links,
  Meta,
  NavLink,
  Outlet,
  Scripts,
  ScrollRestoration,
  isRouteErrorResponse,
  useLoaderData,
  useRevalidator,
  useRouteError,
} from "@remix-run/react";
import { useEffect, useState } from "react";
import clsx from "clsx";
import {
  Activity,
  AlertTriangle,
  BellRing,
  Boxes,
  GitBranch,
  LayoutDashboard,
  Moon,
  Network,
  Pause,
  Play,
  ScrollText,
  Sun,
} from "lucide-react";
import { PreventFlashOnWrongTheme, Theme, ThemeProvider, useTheme } from "remix-themes";
import tailwind from "~/tailwind.css?url";
import { themeSessionResolver } from "~/lib/theme.server";
import { ensureEvaluator } from "~/lib/evaluator.server";
import { cn } from "~/lib/utils";

export const links: LinksFunction = () => [{ rel: "stylesheet", href: tailwind }];

export const meta: MetaFunction = () => [
  { title: "backwork.dev" },
  { name: "description", content: "Self-hosted log aggregation and application performance monitoring." },
];

export async function loader({ request }: LoaderFunctionArgs) {
  ensureEvaluator(); // start the background alert evaluator once
  const { getTheme } = await themeSessionResolver(request);
  // Light is the default. Dark is an explicit, persisted choice.
  return json({ theme: getTheme() ?? Theme.LIGHT });
}

const NAV = [
  { to: "/", label: "Overview", icon: LayoutDashboard, end: true },
  { to: "/containers", label: "Containers", icon: Boxes },
  { to: "/logs", label: "Logs", icon: ScrollText },
  { to: "/metrics", label: "Metrics", icon: Activity },
  { to: "/traces", label: "Traces", icon: GitBranch },
  { to: "/requests", label: "Requests", icon: Network },
  { to: "/incidents", label: "Incidents", icon: AlertTriangle },
  { to: "/alerts", label: "Alerts", icon: BellRing },
];

function ThemeToggle() {
  const [theme, setTheme] = useTheme();
  const dark = theme === Theme.DARK;
  return (
    <button
      type="button"
      onClick={() => setTheme(dark ? Theme.LIGHT : Theme.DARK)}
      className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-border text-muted transition-colors hover:bg-surface-2 hover:text-fg"
      aria-label={dark ? "Switch to light theme" : "Switch to dark theme"}
      title={dark ? "Light theme" : "Dark theme"}
    >
      {dark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
    </button>
  );
}

function LiveStatus() {
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
    <div className="flex items-center gap-2">
      <button
        type="button"
        onClick={() => setPaused((p) => !p)}
        className="inline-flex items-center gap-1.5 rounded-md border border-border px-2 py-1.5 text-2xs font-medium text-muted transition-colors hover:bg-surface-2 hover:text-fg"
        title={paused ? "Resume live updates" : "Pause live updates"}
      >
        {paused ? <Play className="h-3 w-3" /> : <Pause className="h-3 w-3" />}
        <span className={cn("h-1.5 w-1.5 rounded-full", paused ? "bg-faint" : "bg-ok")} />
        {paused ? "Paused" : "Live"}
      </button>
      <span className="hidden text-2xs tabular-nums text-faint sm:inline">
        {revalidator.state !== "idle"
          ? "refreshing"
          : new Date(last).toLocaleTimeString("en-GB", { hour12: false })}
      </span>
    </div>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen lg:grid lg:grid-cols-[224px_1fr]">
      <aside className="hidden flex-col border-r border-border bg-surface lg:flex lg:sticky lg:top-0 lg:h-screen">
        <div className="flex items-center gap-2.5 px-5 py-5">
          <span className="grid h-7 w-7 place-items-center rounded-md bg-brand font-mono text-sm font-bold text-brand-fg">b</span>
          <span className="text-[15px] font-semibold tracking-tight">
            backwork<span className="text-brand">.dev</span>
          </span>
        </div>
        <nav className="flex flex-1 flex-col gap-0.5 px-3 py-2">
          {NAV.map((n) => (
            <NavLink
              key={n.to}
              to={n.to}
              end={n.end}
              prefetch="intent"
              className={({ isActive }) =>
                cn(
                  "flex items-center gap-2.5 rounded-md px-3 py-[7px] text-[13.5px] font-medium transition-colors",
                  isActive ? "bg-brand/10 text-brand" : "text-muted hover:bg-surface-2 hover:text-fg"
                )
              }
            >
              <n.icon className="h-4 w-4 shrink-0" />
              {n.label}
            </NavLink>
          ))}
        </nav>
        <div className="px-5 py-4 text-2xs leading-relaxed text-faint">
          <div className="mb-1 flex items-center gap-1.5">
            <span className="h-1.5 w-1.5 rounded-full bg-ok" />
            Loki · VictoriaMetrics · cAdvisor
          </div>
          self-hosted observability
        </div>
      </aside>

      <div className="flex min-h-screen flex-col">
        <header className="sticky top-0 z-20 flex h-14 items-center justify-between gap-3 border-b border-border bg-bg/85 px-4 backdrop-blur-sm sm:px-6">
          <div className="flex items-center gap-2 lg:hidden">
            <span className="grid h-6 w-6 place-items-center rounded bg-brand font-mono text-xs font-bold text-brand-fg">b</span>
            <span className="text-sm font-semibold">backwork<span className="text-brand">.dev</span></span>
          </div>
          <div className="hidden text-[13px] text-muted lg:block">Log aggregation &amp; application performance monitoring</div>
          <div className="flex items-center gap-2">
            <LiveStatus />
            <ThemeToggle />
          </div>
        </header>
        <main className="mx-auto w-full max-w-[1440px] flex-1 px-4 py-6 sm:px-6">{children}</main>
      </div>

      {/* mobile nav */}
      <nav className="fixed inset-x-0 bottom-0 z-30 flex justify-around border-t border-border bg-surface/95 px-1 py-1 backdrop-blur lg:hidden">
        {NAV.slice(0, 6).map((n) => (
          <NavLink
            key={n.to}
            to={n.to}
            end={n.end}
            className={({ isActive }) =>
              cn("flex flex-col items-center gap-0.5 rounded-md px-3 py-1.5 text-[10px]", isActive ? "text-brand" : "text-muted")
            }
          >
            <n.icon className="h-4 w-4" />
            {n.label}
          </NavLink>
        ))}
      </nav>
    </div>
  );
}

function Document({ children }: { children: React.ReactNode }) {
  const data = useLoaderData<typeof loader>();
  const [theme] = useTheme();
  return (
    <html lang="en" className={clsx(theme)} suppressHydrationWarning>
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <Meta />
        <PreventFlashOnWrongTheme ssrTheme={Boolean(data.theme)} />
        <Links />
      </head>
      <body className="bg-bg text-fg antialiased">
        {children}
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export default function AppWithProviders() {
  const data = useLoaderData<typeof loader>();
  return (
    <ThemeProvider specifiedTheme={data.theme} themeAction="/action/set-theme">
      <Document>
        <Shell>
          <Outlet />
        </Shell>
      </Document>
    </ThemeProvider>
  );
}

export function ErrorBoundary() {
  const error = useRouteError();
  const message = isRouteErrorResponse(error)
    ? `${error.status} ${error.statusText}`
    : error instanceof Error
    ? error.message
    : "Unknown error";
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <title>backwork.dev — error</title>
        <Meta />
        <Links />
      </head>
      <body className="bg-bg text-fg">
        <div className="mx-auto max-w-lg px-6 py-24">
          <div className="text-sm font-semibold text-brand">backwork.dev</div>
          <h1 className="mt-2 text-lg font-semibold">Something broke</h1>
          <p className="mt-1 text-sm text-muted">{message}</p>
        </div>
        <Scripts />
      </body>
    </html>
  );
}
