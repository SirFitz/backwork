// Resource route: GET /robots.txt
export function loader() {
  const body = [
    "User-agent: *",
    "Allow: /$",
    "Allow: /docs",
    "Allow: /pricing",
    "Allow: /security",
    "Allow: /changelog",
    "Allow: /about",
    "Allow: /privacy",
    "Allow: /terms",
    // the product itself is private (auth-gated); keep it out of the index
    "Disallow: /login",
    "Disallow: /register",
    "Disallow: /onboarding",
    "Disallow: /forgot",
    "Disallow: /reset",
    "Disallow: /invite",
    "Disallow: /account",
    "Disallow: /projects",
    "Disallow: /members",
    "Disallow: /teams",
    "Disallow: /alerts",
    "Disallow: /logs",
    "Disallow: /metrics",
    "Disallow: /traces",
    "Disallow: /requests",
    "Disallow: /incidents",
    "Disallow: /containers",
    "Disallow: /settings",
    "",
    "Sitemap: https://backwork.dev/sitemap.xml",
    "",
  ].join("\n");
  return new Response(body, { headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "public, max-age=86400" } });
}
