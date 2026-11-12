import type { ReactNode } from "react";
import { Link } from "@remix-run/react";
import { ArrowRight, Check, Menu, X } from "lucide-react";
import { useState } from "react";
import { cn } from "~/lib/utils";

export const SITE = "https://backwork.dev";
export const CONTACT = "hello@backwork.dev";
export const TAGLINE = "Follow any request, from one ID. Request tracing and performance from the logs you already write.";

export enum NavKey {
  Product = "product",
  Docs = "docs",
  Pricing = "pricing",
  Changelog = "changelog",
  Security = "security",
  About = "about",
}

const NAV: { key: NavKey; label: string; to: string }[] = [
  { key: NavKey.Product, label: "Product", to: "/" },
  { key: NavKey.Docs, label: "Docs", to: "/docs" },
  { key: NavKey.Pricing, label: "Pricing", to: "/pricing" },
  { key: NavKey.Changelog, label: "Changelog", to: "/changelog" },
];

/** Per-page SEO meta (title, description, canonical, OpenGraph, Twitter). */
export function seo({ title, description, path = "/", image = "/og.png" }: { title: string; description: string; path?: string; image?: string }) {
  const url = SITE + (path === "/" ? "" : path);
  const img = image.startsWith("http") ? image : SITE + image;
  return [
    { title },
    { name: "description", content: description },
    { tagName: "link", rel: "canonical", href: url },
    { property: "og:type", content: "website" },
    { property: "og:site_name", content: "backwork" },
    { property: "og:title", content: title },
    { property: "og:description", content: description },
    { property: "og:url", content: url },
    { property: "og:image", content: img },
    { property: "og:image:width", content: "1200" },
    { property: "og:image:height", content: "630" },
    { name: "twitter:card", content: "summary_large_image" },
    { name: "twitter:title", content: title },
    { name: "twitter:description", content: description },
    { name: "twitter:image", content: img },
    { name: "theme-color", content: "#ef5a6f" },
  ];
}

export function JsonLd({ data }: { data: object }) {
  return <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(data) }} />;
}

export function Logo({ small }: { small?: boolean }) {
  return (
    <span className="flex items-center gap-2.5">
      <span className={cn("grid place-items-center rounded-md bg-brand font-mono font-bold text-brand-fg", small ? "h-6 w-6 text-xs" : "h-7 w-7 text-sm")}>b</span>
      <span className={cn("font-semibold tracking-tight", small ? "text-[14px]" : "text-[15px]")}>backwork<span className="text-brand">.dev</span></span>
    </span>
  );
}

export const btnPrimary = "inline-flex h-11 items-center justify-center gap-2 whitespace-nowrap rounded-lg bg-brand px-5 text-[15px] font-semibold text-brand-fg transition-opacity hover:opacity-90";
export const btnSecondary = "inline-flex h-11 items-center justify-center gap-2 whitespace-nowrap rounded-lg border border-border-strong bg-bg px-5 text-[15px] font-semibold text-fg transition-colors hover:bg-surface-2";

export function MarketingShell({ authed, active, children }: { authed?: boolean; active?: NavKey; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="min-h-screen overflow-x-clip bg-bg text-fg">
      <header className="sticky top-0 z-40 border-b border-border bg-bg/85 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-[1200px] items-center gap-10 px-4 sm:px-10">
          <Link to="/" aria-label="backwork home"><Logo /></Link>
          <nav className="hidden flex-1 items-center gap-7 md:flex" aria-label="Main">
            {NAV.map((n) => (
              <Link key={n.key} to={n.to} className={cn("text-[14px] font-medium transition-colors hover:text-fg", active === n.key ? "text-fg" : "text-muted")}>{n.label}</Link>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-5">
            {authed ? (
              <Link to="/" className={cn(btnPrimary, "h-9 px-3.5 text-[14px]")}>Open dashboard</Link>
            ) : (
              <>
                <Link to="/login" className="hidden text-[14px] font-medium text-muted hover:text-fg sm:inline">Sign in</Link>
                <Link to="/register" className={cn(btnPrimary, "hidden h-9 px-3.5 text-[14px] sm:inline-flex")}>Start free</Link>
              </>
            )}
            <button type="button" className="grid h-9 w-9 place-items-center rounded-md border border-border md:hidden" aria-label={open ? "Close menu" : "Open menu"} aria-expanded={open} onClick={() => setOpen((v) => !v)}>
              {open ? <X className="h-4 w-4" /> : <Menu className="h-4 w-4" />}
            </button>
          </div>
        </div>
        {open && (
          <nav className="border-t border-border px-4 pb-4 pt-2 md:hidden" aria-label="Mobile">
            {NAV.map((n) => (
              <Link key={n.key} to={n.to} onClick={() => setOpen(false)} className={cn("block rounded-md px-2 py-2.5 text-[15px] font-medium", active === n.key ? "text-fg" : "text-muted")}>{n.label}</Link>
            ))}
            {!authed && (
              <div className="mt-3 grid gap-2">
                <Link to="/register" className={btnPrimary}>Start free</Link>
                <Link to="/login" className={btnSecondary}>Sign in</Link>
              </div>
            )}
          </nav>
        )}
      </header>
      <main>{children}</main>
      <SiteFooter />
    </div>
  );
}

const FOOTER: [string, [string, string][]][] = [
  ["Product", [["Request view", "/#request-view"], ["Performance", "/#performance"], ["Pricing", "/pricing"], ["Changelog", "/changelog"]]],
  ["Developers", [["Docs", "/docs"], ["Add a service", "/docs#add-a-service"], ["Install the agent", "/docs#agent"], ["Security", "/security"]]],
  ["Company", [["About", "/about"], ["Contact", `mailto:${CONTACT}`], ["Privacy", "/privacy"], ["Terms", "/terms"]]],
];

function SiteFooter() {
  return (
    <footer className="border-t border-border">
      <div className="mx-auto flex max-w-[1200px] flex-col justify-between gap-10 px-4 py-14 sm:px-10 md:flex-row">
        <div className="max-w-[280px]">
          <Logo small />
          <p className="mt-3 text-[14px] text-muted">Follow any request, from one ID.</p>
        </div>
        <div className="grid grid-cols-2 gap-8 sm:grid-cols-3 md:gap-12">
          {FOOTER.map(([title, links]) => (
            <div key={title}>
              <h4 className="mb-3 text-[13px] font-semibold">{title}</h4>
              <ul className="space-y-2">
                {links.map(([label, href]) => (
                  <li key={label}>
                    {href.startsWith("mailto:") ? <a href={href} className="text-[14px] text-muted hover:text-fg">{label}</a>
                      : <Link to={href} className="text-[14px] text-muted hover:text-fg">{label}</Link>}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </div>
      <div className="mx-auto flex max-w-[1200px] flex-col justify-between gap-2 border-t border-border px-4 py-5 text-[13px] text-faint sm:flex-row sm:px-10">
        <span>© 2026 backwork</span>
        <span>Prices in US dollars</span>
      </div>
    </footer>
  );
}

/* ---------- shared page pieces ---------- */

export function Wrap({ className, children, id }: { className?: string; children: ReactNode; id?: string }) {
  return <div id={id} className={cn("mx-auto max-w-[1200px] px-4 sm:px-10", className)}>{children}</div>;
}

export function Eyebrow({ children }: { children: ReactNode }) {
  return (
    <p className="m-0 inline-flex items-center gap-2 font-mono text-[12.5px] font-medium tracking-[0.02em] text-muted">
      <i className="h-1.5 w-1.5 rounded-full bg-brand" />{children}
    </p>
  );
}

export function H2({ children, className }: { children: ReactNode; className?: string }) {
  return <h2 className={cn("mt-3.5 text-balance text-[30px] font-semibold leading-[1.1] tracking-[-0.03em] sm:text-[40px]", className)}>{children}</h2>;
}

export function Lede({ children, className }: { children: ReactNode; className?: string }) {
  return <p className={cn("mt-4 max-w-[58ch] text-[16px] leading-relaxed text-muted sm:text-[16.5px]", className)}>{children}</p>;
}

export function Ticks({ items }: { items: string[] }) {
  return (
    <ul className="mt-7 grid gap-2.5">
      {items.map((t) => (
        <li key={t} className="flex items-start gap-2.5 text-[15px]"><Check className="mt-1 h-4 w-4 shrink-0 text-ok" />{t}</li>
      ))}
    </ul>
  );
}

export function PageHero({ eyebrow, title, children, center }: { eyebrow?: string; title: ReactNode; children?: ReactNode; center?: boolean }) {
  return (
    <section className="border-b border-border">
      <Wrap className={cn("py-16 sm:py-24", center && "text-center")}>
        {eyebrow && <Eyebrow>{eyebrow}</Eyebrow>}
        <h1 className={cn("mt-4 text-balance text-[36px] font-semibold leading-[1.05] tracking-[-0.035em] sm:text-[52px]", center && "mx-auto max-w-[18ch]")}>{title}</h1>
        {children && <div className={cn("mt-5 max-w-[60ch] text-[17px] leading-relaxed text-muted sm:text-[18px]", center && "mx-auto")}>{children}</div>}
      </Wrap>
    </section>
  );
}

export function CtaBand({ secondary = { label: "See pricing", to: "/pricing" } }: { secondary?: { label: string; to: string } }) {
  return (
    <section className="border-b border-border bg-[radial-gradient(700px_300px_at_50%_100%,oklch(var(--brand)/0.07),transparent_70%)]">
      <Wrap className="py-20 text-center sm:py-28">
        <H2 className="mx-auto">Find the next slow request in a minute.</H2>
        <Lede className="mx-auto">Start on the free plan. No card needed.</Lede>
        <div className="mt-8 flex flex-col justify-center gap-3 sm:flex-row">
          <Link to="/register" className={btnPrimary}>Start free <ArrowRight className="h-4 w-4" /></Link>
          {secondary.to.startsWith("mailto:")
            ? <a href={secondary.to} className={btnSecondary}>{secondary.label}</a>
            : <Link to={secondary.to} className={btnSecondary}>{secondary.label}</Link>}
        </div>
      </Wrap>
    </section>
  );
}

/** Shared layout for legal pages (privacy, terms). */
export function LegalArticle({ title, effective, sections }: { title: string; effective: string; sections: [string, string[]][] }) {
  return (
    <article className="mx-auto max-w-3xl px-4 py-14 sm:px-6 lg:py-20">
      <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">{title}</h1>
      <p className="mt-2 text-[13px] text-faint">Effective {effective}</p>
      <div className="mt-8 space-y-8">
        {sections.map(([h, paras]) => (
          <section key={h}>
            <h2 className="text-base font-semibold">{h}</h2>
            {paras.map((p, i) => <p key={i} className="mt-2 text-[14.5px] leading-relaxed text-muted">{p}</p>)}
          </section>
        ))}
      </div>
    </article>
  );
}
