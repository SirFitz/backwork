import type { LoaderFunctionArgs, MetaFunction } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import { ArrowRight, Eye, EyeOff, Filter, KeyRound, Layers, Lock, ShieldAlert, ToggleRight } from "lucide-react";
import { getUser } from "~/lib/auth/context.server";
import { CtaBand, MarketingShell, PageHero, Wrap, btnPrimary, seo } from "~/components/marketing";

export const meta: MetaFunction = () =>
  seo({
    title: "Security — backwork",
    description: "Sensitive data filtered on your server before it is sent, every organisation's data kept apart, no request bodies ever read, encryption at rest and hardened sessions.",
    path: "/security",
  });

export async function loader({ request }: LoaderFunctionArgs) {
  return json({ authed: !!(await getUser(request)) });
}

const PRINCIPLES = [
  { icon: Filter, title: "Filtered before it leaves your server", body: "The agent removes card numbers, email addresses, phone numbers, passwords, API keys and tokens, plus any patterns you add, before a line is sent. backwork runs the same filter again when it receives the line." },
  { icon: EyeOff, title: "Bodies and parameters are never read", body: "Correlator carries an ID and times each step. It never reads request or response bodies or function parameters, and database calls are recorded with their timing only, never their values." },
  { icon: ToggleRight, title: "Off means off", body: "Every kind of data has a switch, for the organisation, a project or one service. A switch that is off in your code or in the dashboard wins, and every change is written to the audit log." },
  { icon: Layers, title: "Each organisation kept apart", body: "Every organisation's data carries an enforced organisation ID, set when it arrives and checked on every query. No organisation can read another's data." },
  { icon: Lock, title: "Encrypted and hashed at rest", body: "Alert-channel secrets are sealed with AES-256-GCM. Ingest tokens are stored only as SHA-256 hashes. Passwords use argon2id with a server-side pepper." },
  { icon: KeyRound, title: "Hardened sessions", body: "Signed, HttpOnly, Secure cookies with server-side revocation: signing out or changing a password ends every other session. Sign-in is rate limited per address and per account." },
  { icon: ShieldAlert, title: "Safe by construction", body: "Same-origin checks on every change, webhook guards that block internal and metadata addresses, and redirects that can only stay on backwork." },
  { icon: Eye, title: "Honest by design", body: "A source that stops sending reads as “no data”, never “healthy”, so a gap in what backwork receives is visible rather than hidden." },
];

export default function Security() {
  const { authed } = useLoaderData<typeof loader>();
  return (
    <MarketingShell authed={authed}>
      <PageHero eyebrow="Security" title="Built to keep less, and keep it apart.">
        Request data describes exactly how your systems work. backwork collects only what it needs to follow a request, filters sensitive data at the source, and keeps each organisation's data to itself.
      </PageHero>
      <section className="border-b border-border">
        <Wrap className="grid gap-x-12 gap-y-10 py-16 sm:grid-cols-2 sm:py-20">
          {PRINCIPLES.map(({ icon: Icon, title, body }) => (
            <div key={title} className="border-t border-border pt-5">
              <div className="flex items-center gap-2.5">
                <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-surface-2 text-fg"><Icon className="h-4 w-4" /></span>
                <h2 className="text-[16px] font-semibold">{title}</h2>
              </div>
              <p className="mt-3 text-[14.5px] leading-relaxed text-muted">{body}</p>
            </div>
          ))}
        </Wrap>
      </section>
      <section className="border-b border-border bg-surface">
        <Wrap className="flex flex-col items-start justify-between gap-6 py-14 sm:flex-row sm:items-center">
          <div>
            <h2 className="text-[22px] font-semibold tracking-tight">Found something?</h2>
            <p className="mt-2 max-w-[56ch] text-[14.5px] text-muted">Send us the details privately and we will reply promptly. Please don't post vulnerabilities in public.</p>
          </div>
          <a href="mailto:security@backwork.dev?subject=Security%20report" className={btnPrimary}>Report a vulnerability <ArrowRight className="h-4 w-4" /></a>
        </Wrap>
      </section>
      <CtaBand />
    </MarketingShell>
  );
}

