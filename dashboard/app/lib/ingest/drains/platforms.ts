/**
 * Platform log drains (BAC-98): the platforms whose own log drain can post to backwork with no
 * install, the path each posts to, and the setup steps the Projects page shows. Client-safe (no
 * server imports): the parsers are in ./<platform>.server.ts.
 */

/** Platforms with a no-install log push backwork takes. */
export const DrainPlatform = {
  Vercel: "vercel",
  Heroku: "heroku",
  Fly: "fly",
  Cloudflare: "cloudflare",
} as const;
export type DrainPlatform = (typeof DrainPlatform)[keyof typeof DrainPlatform];

export const DRAIN_PLATFORMS: readonly DrainPlatform[] = Object.values(DrainPlatform);

export function drainPlatformOf(v: string | undefined): DrainPlatform | null {
  return (DRAIN_PLATFORMS as readonly string[]).includes(v ?? "") ? (v as DrainPlatform) : null;
}

/** Platforms asked for that have no no-install push backwork can take (see BAC-98 DONE.md). */
export const NoPushPlatform = { Render: "render", Railway: "railway" } as const;
export type NoPushPlatform = (typeof NoPushPlatform)[keyof typeof NoPushPlatform];

/** The drain path for a platform. */
export function drainPath(p: DrainPlatform): string {
  return `/ingest/drains/${p}`;
}

/** One setup step: text, and optionally a block to copy. */
export interface DrainStep {
  text: string;
  copy?: string;
}

export interface DrainGuide {
  platform: DrainPlatform;
  label: string;
  /** Where the service name and host come from. */
  naming: string;
  steps: DrainStep[];
}

export interface NoPushGuide {
  platform: NoPushPlatform;
  label: string;
  why: string;
}

/** Placeholder shown where the one-time token goes. */
export const TOKEN_PLACEHOLDER = "<YOUR_INGEST_TOKEN>";

/** Setup steps for every platform, for a backwork at BASE_URL and an ingest token (or the placeholder). */
export function drainGuides(baseUrl: string, token: string = TOKEN_PLACEHOLDER): DrainGuide[] {
  const base = baseUrl.replace(/\/+$/, "");
  const url = (p: DrainPlatform): string => `${base}${drainPath(p)}`;
  const host = base.replace(/^https?:\/\//, "");
  const scheme = base.startsWith("http://") ? "http" : "https";
  return [
    {
      platform: DrainPlatform.Vercel,
      label: "Vercel",
      naming: "Service is the Vercel project name (the project ID when Vercel leaves the name out); host is the execution region (build for build logs).",
      steps: [
        { text: "Team Settings → Drains → Add Drain → Logs. Pick the projects, sources and environments (Pro or Enterprise plan)." },
        { text: "Destination: Custom Endpoint. Endpoint URL:", copy: url(DrainPlatform.Vercel) },
        { text: "Format: NDJSON (JSON works too). Custom Headers:", copy: `Authorization: Bearer ${token}` },
        { text: "Create the drain. Vercel sends test events; they appear in Logs under the project name." },
      ],
    },
    {
      platform: DrainPlatform.Heroku,
      label: "Heroku",
      naming: "Service is the name after ?service= (Heroku does not send the app name); host is the dyno (web.1, router).",
      steps: [
        { text: "Add an HTTPS drain to the app. The token goes in the URL as the Basic auth password, the way Heroku authenticates drains:", copy: `heroku drains:add "${scheme}://bw:${token}@${host}${drainPath(DrainPlatform.Heroku)}?service=my-api" -a my-app` },
        { text: "Repeat for each app with its own service name. heroku drains -a my-app lists them." },
      ],
    },
    {
      platform: DrainPlatform.Fly,
      label: "Fly.io",
      naming: "Service is the Fly app name; host is the Machine ID.",
      steps: [
        { text: "Fly has no built-in drain: run Fly's own log shipper as one small app in your organisation. Your apps are not changed." },
        { text: "Create it from Fly's image:", copy: "fly launch --image ghcr.io/superfly/fly-log-shipper:latest --name my-log-shipper --no-deploy" },
        { text: "Give it read access to your org's logs and point its HTTP sink at backwork. The Fly token stays in Fly:", copy: `fly secrets set -a my-log-shipper ORG=personal ACCESS_TOKEN="$(fly tokens create readonly personal)" \\\n  HTTP_URL=${url(DrainPlatform.Fly)} HTTP_TOKEN=${token}` },
        { text: "Deploy it:", copy: "fly deploy -a my-log-shipper" },
      ],
    },
    {
      platform: DrainPlatform.Cloudflare,
      label: "Cloudflare",
      naming: "Workers: service is the script name. HTTP requests: service is the hostname. Other datasets: ?service= or cloudflare.",
      steps: [
        { text: "Workers: turn on Logpush for the Worker (logpush = true in its Wrangler config, or Settings → Observability)." },
        { text: "Analytics & Logs → Logpush → Create job → HTTP destination. Cloudflare sets request headers only from header_ parameters on the destination URL; it sends them as headers and backwork never reads a token from the query:", copy: `${url(DrainPlatform.Cloudflare)}?header_Authorization=Bearer%20${token}` },
        {
          text: "Or with the API (dataset workers_trace_events per account, http_requests per zone):",
          copy:
            `curl "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/logpush/jobs" \\\n` +
            `  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" --json '{\n` +
            `    "name": "backwork", "dataset": "workers_trace_events", "enabled": true,\n` +
            `    "destination_conf": "${url(DrainPlatform.Cloudflare)}?header_Authorization=Bearer%20${token}",\n` +
            `    "output_options": { "field_names": ["EventTimestampMs","ScriptName","Outcome","Event","Logs","Exceptions"] },\n` +
            `    "max_upload_bytes": 5000000, "max_upload_records": 1000 }'`,
        },
      ],
    },
  ];
}

export const NO_PUSH_GUIDES: readonly NoPushGuide[] = [
  {
    platform: NoPushPlatform.Render,
    label: "Render",
    why: "Render streams logs to your own endpoint only as syslog over TLS (TCP); its HTTPS option is limited to Datadog and Loggly. backwork takes HTTP only, so set CORRELATOR_RECORD_SINK or OTLP on the service instead.",
  },
  {
    platform: NoPushPlatform.Railway,
    label: "Railway",
    why: "Railway has no log drain: nothing forwards a service's output to an outside URL. Set CORRELATOR_RECORD_SINK or OTLP on the service instead.",
  },
];
