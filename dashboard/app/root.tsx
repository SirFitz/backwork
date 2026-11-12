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
  useFetcher,
  useLoaderData,
  useLocation,
  useNavigate,
  useRevalidator,
  useRouteError,
} from "@remix-run/react";
import { useCallback, useEffect, useRef, useState } from "react";
import clsx from "clsx";
import {
  ArrowRight,
  BellRing,
  Bug,
  Building2,
  Check,
  ChevronDown,
  CircleUser,
  Cog,
  FolderKanban,
  Gauge,
  KeyRound,
  LayoutDashboard,
  LogOut,
  Moon,
  MoreHorizontal,
  Network,
  Pause,
  Play,
  ScrollText,
  Search,
  Sun,
  Users,
} from "lucide-react";
import { PreventFlashOnWrongTheme, Theme, ThemeProvider, useTheme } from "remix-themes";
import tailwind from "~/tailwind.css?url";
import { themeSessionResolver } from "~/lib/theme.server";
import { ensureEvaluator } from "~/lib/evaluator.server";
import { requireOrg, getUser } from "~/lib/auth/context.server";
import { cn } from "~/lib/utils";
import type { LookupPreview } from "~/routes/lookup";
import { Clock } from "~/components/time";

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
// machine endpoints (/ingest, /install.sh, /healthz) are resource routes
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

// The dashboard polls every 10s (LiveStatus → revalidator.revalidate()), which
// re-runs every loader including root (2 Postgres queries for nav/org). Root data
// only changes on navigation or a mutation, so skip it for the same-path timed
// poll — leaf loaders still refresh. (PERF-5)
export function shouldRevalidate({ currentUrl, nextUrl, formMethod }: { currentUrl: URL; nextUrl: URL; formMethod?: string }) {
  if (formMethod && formMethod.toUpperCase() !== "GET") return true; // mutations
  if (currentUrl.pathname !== nextUrl.pathname) return true; // real navigation / redirects
  return false; // same-path timed revalidation → skip root
}

const NAV = [
  { to: "/", label: "Overview", icon: LayoutDashboard, end: true },
  { to: "/requests", label: "Requests", icon: Network },
  { to: "/performance", label: "Performance", icon: Gauge },
  { to: "/logs", label: "Logs", icon: ScrollText },
  { to: "/errors", label: "Errors", icon: Bug },
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
  // null until mounted: a clock rendered on the server never matches the browser's (hydration).
  const [last, setLast] = useState<number | null>(null);
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
          : last === null ? "" : new Date(last).toLocaleTimeString("en-GB", { hour12: false })}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------- find a request (design 7.1)

type LookupData = { preview: LookupPreview; q: string };

const RULE_LABEL: Record<string, string> = { hex: "trace ID", uuid: "UUID", traceparent: "traceparent", derived: "request ID" };

function fmtTook(us: number | null): string {
  if (us === null) return "";
  const ms = us / 1000;
  if (ms < 100) return `${ms.toFixed(1)} ms`;
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

function shortId(id: string): string {
  return `${id.slice(0, 8)}…${id.slice(-8)}`;
}

/** One search box in the header of every page. Results open in the browser's top layer
 *  (UI_ISSUES.md entry 2), positioned against the window, so no header, sidebar or table can cut them. */
function FindRequest() {
  const fetcher = useFetcher<LookupData>();
  const navigate = useNavigate();
  const location = useLocation();
  const inputRef = useRef<HTMLInputElement>(null);
  const phoneInputRef = useRef<HTMLInputElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const anchorRef = useRef<HTMLDivElement>(null);
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [phone, setPhone] = useState(false);
  const loadRef = useRef(fetcher.load);
  loadRef.current = fetcher.load;

  const place = useCallback(() => {
    const pop = popRef.current;
    if (!pop) return;
    const narrow = window.innerWidth < 640;
    setPhone(narrow);
    if (narrow) {
      Object.assign(pop.style, { top: "56px", left: "0px", width: "100vw", maxWidth: "100vw" });
      return;
    }
    const box = anchorRef.current?.getBoundingClientRect();
    if (!box) return;
    const width = Math.min(Math.max(box.width, 360), 560, window.innerWidth - 32);
    const left = Math.min(box.left, window.innerWidth - width - 16);
    Object.assign(pop.style, { top: `${box.bottom + 8}px`, left: `${Math.max(16, left)}px`, width: `${width}px`, maxWidth: "" });
  }, []);

  const show = useCallback(() => {
    const pop = popRef.current;
    if (!pop) return;
    place();
    if (!pop.matches(":popover-open")) pop.showPopover();
    setOpen(true);
  }, [place]);

  const hide = useCallback(() => {
    const pop = popRef.current;
    if (pop?.matches(":popover-open")) pop.hidePopover();
    setOpen(false);
  }, []);

  // The popover attribute is set here: React 18 does not type it.
  useEffect(() => {
    popRef.current?.setAttribute("popover", "manual");
  }, []);

  // Close and clear on navigation.
  useEffect(() => {
    hide();
    setQ("");
  }, [location.pathname, hide]);

  // Resolve as the person types (debounced); only the server turns input into a query.
  useEffect(() => {
    const value = q.trim();
    if (!value) return;
    const t = setTimeout(() => loadRef.current(`/lookup?preview=1&q=${encodeURIComponent(value)}`), 220);
    return () => clearTimeout(t);
  }, [q]);

  // Cmd/Ctrl+K focuses the box; Escape closes; a click outside closes.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        if (window.innerWidth < 640) { show(); setTimeout(() => phoneInputRef.current?.focus(), 0); }
        else inputRef.current?.focus();
      }
      if (e.key === "Escape" && popRef.current?.matches(":popover-open")) {
        hide();
        inputRef.current?.blur();
      }
    };
    const onDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (popRef.current?.contains(target) || anchorRef.current?.contains(target)) return;
      hide();
    };
    const onResize = () => { if (popRef.current?.matches(":popover-open")) place(); };
    window.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onDown);
    window.addEventListener("resize", onResize);
    window.addEventListener("scroll", onResize, true);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onDown);
      window.removeEventListener("resize", onResize);
      window.removeEventListener("scroll", onResize, true);
    };
  }, [hide, place, show]);

  const data = q.trim() && fetcher.data && fetcher.data.q.trim() === q.trim() ? fetcher.data.preview : null;
  const busy = fetcher.state !== "idle" || (q.trim() !== "" && !data);
  const target = data && data.ok ? `/requests/${data.traceId}${data.rule === "hex" ? "" : `?q=${encodeURIComponent(data.input)}`}` : null;

  const submit = (e: React.FormEvent) => {
    if (target) {
      e.preventDefault();
      navigate(target);
    }
    // Without a resolution yet the form goes to /lookup, which redirects or explains.
  };

  const onChange = (value: string) => {
    setQ(value);
    if (value.trim()) show();
    else if (!phone) hide();
  };

  const field = (ref: React.RefObject<HTMLInputElement>, autoFocus: boolean) => (
    <form method="get" action="/lookup" onSubmit={submit} role="search" className="relative w-full">
      <Search className="pointer-events-none absolute left-2.5 top-1/2 h-[15px] w-[15px] -translate-y-1/2 text-faint" />
      <input
        ref={ref}
        name="q"
        value={q}
        autoFocus={autoFocus}
        autoComplete="off"
        spellCheck={false}
        onChange={(e) => onChange(e.target.value)}
        onFocus={() => { if (q.trim()) show(); }}
        placeholder="Find a request: paste a trace ID or request ID"
        aria-label="Find a request by trace ID or request ID"
        className="h-[34px] w-full rounded-lg border border-border bg-surface pl-[31px] pr-12 font-mono text-[12.5px] text-fg outline-none placeholder:font-sans placeholder:text-[13px] placeholder:text-faint focus:border-brand focus:ring-[3px] focus:ring-brand/15"
      />
      <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 rounded border border-border bg-bg px-[5px] py-px font-mono text-[10.5px] font-medium text-faint">
        {open ? "esc" : "⌘K"}
      </span>
    </form>
  );

  return (
    <>
      <div ref={anchorRef} className="hidden max-w-[560px] flex-1 sm:block">{field(inputRef, false)}</div>
      <button
        type="button"
        className="ml-auto inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-border text-muted hover:bg-surface-2 hover:text-fg sm:hidden"
        aria-label="Find a request"
        onClick={() => { if (open) hide(); else { show(); setTimeout(() => phoneInputRef.current?.focus(), 0); } }}
      >
        <Search className="h-[15px] w-[15px]" />
      </button>
      <div
        ref={popRef}
        className={cn(
          "fixed m-0 overflow-auto border-border-strong bg-bg p-0 text-fg shadow-[0_1px_2px_oklch(0.2_0.01_60/0.06),0_22px_44px_-16px_oklch(0.2_0.01_60/0.28)]",
          phone ? "max-h-[calc(100dvh-56px)] rounded-none border-0 border-b" : "max-h-[min(70vh,520px)] rounded-xl border",
        )}
        style={{ inset: "auto" }}
      >
        {phone ? <div className="px-4 py-2.5">{field(phoneInputRef, false)}</div> : null}
        {!q.trim() ? (
          <div className="flex gap-2 border-t border-border px-4 py-2.5 text-xs leading-normal text-muted">
            Accepts a trace ID, a request ID, a UUID or a full <span className="font-mono">traceparent</span>.
          </div>
        ) : !data ? (
          <div className="flex items-center gap-2 border-t border-border px-4 py-2.5 text-xs text-muted sm:border-t-0" role="status">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-info" /> Searching…
          </div>
        ) : !data.ok ? (
          <div className="border-t border-border px-4 py-2.5 text-xs text-err sm:border-t-0" role="alert">{data.message}</div>
        ) : (
          <>
            <div className={cn("flex border-b border-border px-4 py-2.5 text-xs text-muted sm:px-3.5", phone ? "flex-col items-start gap-1.5 border-t" : "items-center gap-2")}>
              <div className="flex min-w-0 items-center"><span className="mr-1.5 text-[10.5px] uppercase tracking-wide text-faint">{RULE_LABEL[data.rule]}</span><span className="truncate font-mono text-[11.5px] text-fg">{data.input}</span></div>
              {data.rule !== "hex" ? (
                <>
                  {phone ? null : <ArrowRight className="h-3.5 w-3.5 shrink-0" />}
                  <div className="flex min-w-0 items-center"><span className="mr-1.5 text-[10.5px] uppercase tracking-wide text-faint">trace</span><span className="font-mono text-[11.5px] text-fg">{phone ? shortId(data.traceId) : data.traceId}</span></div>
                </>
              ) : null}
            </div>
            {data.summary && target ? (
              <Link to={target} className="flex items-center justify-between gap-3 border-b border-border bg-surface-2 px-4 py-3 hover:bg-surface-2/70 sm:px-3.5">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2 font-mono text-sm font-semibold">
                    <span className="min-w-0 [overflow-wrap:anywhere]">{data.summary.method ? <span className="font-medium text-faint">{data.summary.method} </span> : null}{data.summary.op ?? data.summary.service}</span>
                    {data.summary.status !== null ? (
                      <span className={cn("inline-flex items-center rounded px-1.5 py-0.5 font-sans text-2xs font-medium ring-1 ring-inset", data.summary.status >= 500 ? "bg-err/10 text-err ring-err/25" : data.summary.status >= 400 ? "bg-warn/10 text-warn ring-warn/25" : "bg-ok/10 text-ok ring-ok/25")}>{data.summary.status}</span>
                    ) : null}
                  </div>
                  <div className="mt-[3px] text-xs text-muted">
                    {data.summary.service} · {data.summary.services} {data.summary.services === 1 ? "service" : "services"}
                    {data.summary.durationUs !== null ? <> · <span className="font-mono">{fmtTook(data.summary.durationUs)}</span></> : <> · still open</>}
                    {phone ? null : <> · <Clock ts={data.summary.startMs} seconds className="font-mono" /></>}
                  </div>
                </div>
                <span className="inline-flex shrink-0 items-center gap-1.5 text-xs font-medium text-brand">
                  {phone ? <ArrowRight className="h-[15px] w-[15px]" /> : <>Open <span className="rounded border border-border bg-bg px-[5px] py-px font-mono text-[10.5px] text-faint">&#8629;</span></>}
                </span>
              </Link>
            ) : null}
            <div className="flex gap-2 px-4 py-2.5 text-xs leading-normal text-muted sm:px-3.5">
              {data.error ? (
                <span className="text-err">Hop records unavailable: {data.error}</span>
              ) : data.found ? (
                <>
                  <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-ok" />
                  <span>Found in {data.searched}.{phone ? null : <> Accepts a trace ID, a request ID, a UUID or a full <span className="font-mono">traceparent</span>. Search reaches back 30 days.</>}</span>
                </>
              ) : (
                <span>No hop records in {data.searched}. <Link className="font-medium text-brand" to={target ?? "/lookup"}>Open the request anyway</Link> to search its log lines.</span>
              )}
            </div>
          </>
        )}
        {busy && data ? <span className="sr-only">Updating</span> : null}
      </div>
    </>
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
          {(auth.role === "owner" || auth.role === "admin") ? <Link to="/audit" onClick={() => setOpen(false)} className={link}><ScrollText className="h-3.5 w-3.5" /> Audit log</Link> : null}
          {(auth.role === "owner" || auth.role === "admin") ? <Link to="/api-keys" onClick={() => setOpen(false)} className={link}><KeyRound className="h-3.5 w-3.5" /> API keys</Link> : null}
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
    <div className="min-h-screen lg:grid lg:grid-cols-[224px_minmax(0,1fr)]">
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
            Loki · VictoriaMetrics
          </div>
          self-hosted observability
        </div>
      </aside>

      <div className="flex min-h-screen min-w-0 flex-col">
        <header className="sticky top-0 z-20 flex h-14 items-center justify-between gap-3 border-b border-border bg-bg/85 px-4 backdrop-blur-sm sm:px-6">
          <div className="flex items-center gap-2 lg:hidden">
            <span className="grid h-6 w-6 place-items-center rounded bg-brand font-mono text-xs font-bold text-brand-fg">b</span>
            <span className="text-sm font-semibold">backwork<span className="text-brand">.dev</span></span>
          </div>
          <FindRequest />
          <div className="flex shrink-0 items-center gap-2">
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
  // Phone tabs: Overview, Requests, Performance, Logs, then More.
  const primary = NAV.slice(0, 4);
  const rest = NAV.slice(4);
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
