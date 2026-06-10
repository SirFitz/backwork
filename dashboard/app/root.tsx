import type { LinksFunction, LoaderFunctionArgs, MetaFunction } from "@remix-run/node";
import { json } from "@remix-run/node";
import {
  Form,
  Link,
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
import { useEffect, useRef, useState } from "react";
import clsx from "clsx";
import {
  Activity,
  AlertTriangle,
  BellRing,
  Boxes,
  Building2,
  ChevronDown,
  CircleUser,
  Cog,
  FolderKanban,
  GitBranch,
  LayoutDashboard,
  LogOut,
  Moon,
  MoreHorizontal,
  Network,
  Pause,
  Play,
  ScrollText,
  Sun,
  Users,
} from "lucide-react";
import { PreventFlashOnWrongTheme, Theme, ThemeProvider, useTheme } from "remix-themes";
import tailwind from "~/tailwind.css?url";
import { themeSessionResolver } from "~/lib/theme.server";
import { ensureEvaluator } from "~/lib/evaluator.server";
import { requireOrg, getUser } from "~/lib/auth/context.server";
import { cn } from "~/lib/utils";

type AuthData = {
  user: { name: string; email: string };
  org: { id: string; name: string; slug: string };
  role: string;
  orgs: { id: string; name: string }[];
} | null;

export const links: LinksFunction = () => [{ rel: "stylesheet", href: tailwind }];

export const meta: MetaFunction = () => [
  { title: "backwork.dev" },
  { name: "description", content: "Self-hosted log aggregation and application performance monitoring." },
];

// Public routes render bare (no app shell) and don't require a session. The
// machine endpoints (/ingest, /otlp, /install.sh, /healthz) are resource routes
// that never invoke this root loader, so agents are unaffected.
const PUBLIC_PATHS = new Set(["/login", "/register", "/onboarding", "/forgot"]);
// Public marketing pages: render bare (own chrome), never require a session.
const MARKETING_PATHS = new Set(["/pricing", "/security", "/docs", "/about", "/privacy", "/terms", "/changelog"]);

export async function loader({ request }: LoaderFunctionArgs) {
  ensureEvaluator(); // start the background alert evaluator once
  const path = new URL(request.url).pathname;
  const isPublic = PUBLIC_PATHS.has(path) || path.startsWith("/invite") || path.startsWith("/reset");
  const { getTheme } = await themeSessionResolver(request);
  const theme = getTheme() ?? Theme.LIGHT;
  if (isPublic || MARKETING_PATHS.has(path)) return json({ theme, auth: null as AuthData });
  // "/" is dual: the marketing landing for logged-out visitors, the dashboard for
  // signed-in users. Only fall through to requireOrg (app shell) when signed in.
  if (path === "/" && !(await getUser(request))) return json({ theme, auth: null as AuthData });
  const ctx = await requireOrg(request); // redirects to /login or /onboarding
  return json({
    theme,
    auth: {
      user: { name: ctx.user.name, email: ctx.user.email },
      org: ctx.org,
      role: ctx.role,
      orgs: ctx.memberships.map((m) => ({ id: m.orgId, name: m.orgName })),
    } as AuthData,
  });
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
  { to: "/projects", label: "Projects", icon: FolderKanban },
  { to: "/settings", label: "Settings", icon: Cog },
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
        className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border px-2.5 text-2xs font-medium text-muted transition-colors hover:bg-surface-2 hover:text-fg"
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

function AuthMenu({ auth }: { auth: NonNullable<AuthData> }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, []);
  const link = "flex items-center gap-2 rounded px-2 py-1.5 text-[13px] text-fg hover:bg-surface-2";
  return (
    <div className="relative" ref={ref}>
      <button onClick={() => setOpen((o) => !o)} className="flex h-8 items-center gap-1.5 rounded-md border border-border px-2.5 text-2xs font-medium text-muted hover:bg-surface-2 hover:text-fg">
        <Building2 className="h-3.5 w-3.5 shrink-0" />
        <span className="hidden max-w-[120px] truncate text-fg sm:inline">{auth.org.name}</span>
        <ChevronDown className="h-3 w-3 shrink-0" />
      </button>
      {open ? (
        <div className="absolute right-0 z-40 mt-1.5 w-60 rounded-lg border border-border bg-surface p-1 shadow-lg">
          {auth.orgs.length > 1 ? (
            <div className="mb-1 border-b border-border px-1 pb-1.5">
              <div className="px-2 py-1 text-2xs uppercase tracking-wide text-faint">Organizations</div>
              {auth.orgs.map((o) => (
                <Form key={o.id} method="post" action="/action/set-org">
                  <input type="hidden" name="orgId" value={o.id} />
                  <button className={cn("flex w-full items-center gap-2 rounded px-2 py-1.5 text-[13px] hover:bg-surface-2", o.id === auth.org.id ? "text-brand" : "text-fg")}>
                    <Building2 className="h-3.5 w-3.5 shrink-0" /> <span className="truncate">{o.name}</span>
                  </button>
                </Form>
              ))}
            </div>
          ) : null}
          <Link to="/projects" onClick={() => setOpen(false)} className={link}><FolderKanban className="h-3.5 w-3.5" /> Projects</Link>
          <Link to="/members" onClick={() => setOpen(false)} className={link}><Users className="h-3.5 w-3.5" /> Members</Link>
          <Link to="/teams" onClick={() => setOpen(false)} className={link}><Users className="h-3.5 w-3.5" /> Teams</Link>
          <Link to="/account" onClick={() => setOpen(false)} className={link}><CircleUser className="h-3.5 w-3.5" /> Account</Link>
          <Link to="/onboarding" onClick={() => setOpen(false)} className={link}><Building2 className="h-3.5 w-3.5" /> New organization</Link>
          <div className="mt-1 border-t border-border pt-1">
            <div className="truncate px-2 py-1 text-2xs text-faint">{auth.user.email} · {auth.role}</div>
            <Form method="post" action="/logout">
              <button className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-[13px] text-err hover:bg-surface-2"><LogOut className="h-3.5 w-3.5" /> Sign out</button>
            </Form>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function Shell({ auth, children }: { auth: NonNullable<AuthData>; children: React.ReactNode }) {
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
            <span className="h-1.5 w-1.5 rounded-full bg-faint" />
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
            <AuthMenu auth={auth} />
          </div>
        </header>
        <main className="mx-auto w-full max-w-[1440px] flex-1 px-4 pt-6 pb-24 sm:px-6 lg:py-6">{children}</main>
      </div>

      <MobileNav />
    </div>
  );
}

function MobileNav() {
  const [more, setMore] = useState(false);
  const primary = NAV.slice(0, 5);
  const rest = NAV.slice(5);
  const tab = (active: boolean) => cn("flex flex-1 flex-col items-center gap-0.5 rounded-md px-1 py-1.5 text-[10px]", active ? "text-brand" : "text-muted");
  return (
    <>
      {more ? (
        <div className="fixed inset-0 z-40 lg:hidden" onClick={() => setMore(false)}>
          <div className="absolute inset-0 bg-black/40 backdrop-blur-[1px]" />
          <div className="absolute inset-x-0 bottom-[52px] rounded-t-2xl border-t border-border-strong bg-surface p-2 shadow-lg" onClick={(e) => e.stopPropagation()}>
            <div className="px-2 py-1.5 text-2xs font-medium uppercase tracking-wide text-faint">More</div>
            <div className="grid grid-cols-3 gap-1 pb-1">
              {rest.map((n) => (
                <NavLink key={n.to} to={n.to} end={n.end} onClick={() => setMore(false)} className={({ isActive }) => cn("flex flex-col items-center gap-1.5 rounded-lg px-2 py-3 text-2xs", isActive ? "bg-brand/10 text-brand" : "text-muted hover:bg-surface-2")}>
                  <n.icon className="h-[18px] w-[18px]" />
                  {n.label}
                </NavLink>
              ))}
            </div>
          </div>
        </div>
      ) : null}
      <nav className="fixed inset-x-0 bottom-0 z-30 flex border-t border-border bg-surface/95 px-1 py-1 backdrop-blur lg:hidden">
        {primary.map((n) => (
          <NavLink key={n.to} to={n.to} end={n.end} className={({ isActive }) => tab(isActive)}>
            <n.icon className="h-4 w-4" />
            {n.label}
          </NavLink>
        ))}
        <button type="button" onClick={() => setMore((m) => !m)} className={tab(more)} aria-label="More navigation">
          <MoreHorizontal className="h-4 w-4" />
          More
        </button>
      </nav>
    </>
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
        <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
        <script dangerouslySetInnerHTML={{ __html: "document.documentElement.classList.add('js')" }} />
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
        {data.auth ? (
          <Shell auth={data.auth}>
            <Outlet />
          </Shell>
        ) : (
          <Outlet />
        )}
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
