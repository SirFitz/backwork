// Resource route: GET /sitemap.xml
const SITE = "https://backwork.dev";
const PAGES = [
  { loc: "/", priority: "1.0", changefreq: "weekly" },
  { loc: "/pricing", priority: "0.8", changefreq: "monthly" },
  { loc: "/security", priority: "0.6", changefreq: "monthly" },
];

export function loader() {
  const urls = PAGES.map(
    (p) => `  <url><loc>${SITE}${p.loc === "/" ? "" : p.loc}/</loc><changefreq>${p.changefreq}</changefreq><priority>${p.priority}</priority></url>`
  ).join("\n");
  const body = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
  return new Response(body, { headers: { "Content-Type": "application/xml; charset=utf-8", "Cache-Control": "public, max-age=86400" } });
}
