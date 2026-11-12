import type { LoaderFunctionArgs, MetaFunction } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import { Eye, Fingerprint, Users } from "lucide-react";
import { getUser } from "~/lib/auth/context.server";
import { CtaBand, MarketingShell, PageHero, Wrap, seo } from "~/components/marketing";

export const meta: MetaFunction = () =>
  seo({
    title: "About — backwork",
    description: "Why we built backwork: one ID should be enough to find out what happened to a request, for support and business owners as much as engineers.",
    path: "/about",
  });

export async function loader({ request }: LoaderFunctionArgs) {
  return json({ authed: !!(await getUser(request)) });
}

const VALUES = [
  { icon: Fingerprint, title: "One ID is enough", body: "Whatever reference someone holds (a request ID from an error page, an order number, a provider's reference) should lead straight to what happened." },
  { icon: Users, title: "Readable by anyone", body: "Support and business owners ask “what happened to this payment?” as often as engineers do. The answer should be in words they can read, not a wall of spans." },
  { icon: Eye, title: "Honest, and careful with data", body: "Never green because nothing arrived. Never a request body read. Sensitive data filtered on your server, and a switch for everything we collect." },
];

export default function About() {
  const { authed } = useLoaderData<typeof loader>();
  return (
    <MarketingShell authed={authed}>
      <PageHero eyebrow="About" title="Built for the question “what happened to this request?”">
        backwork started from a familiar problem in a payments platform: when a customer asked why something hadn't gone through, finding out meant searching several services' logs by hand, by timestamp, hoping the clocks agreed.
      </PageHero>
      <section className="border-b border-border">
        <Wrap className="py-14 sm:py-20">
          <div className="max-w-[68ch] space-y-5 text-[16px] leading-[1.75] text-muted">
            <p>So we built the tool we wanted. Correlator, a small library, gives every request one ID and carries it through every call, job and message, writing it into the log lines your services already produce. backwork reads those lines and rebuilds the request: every service it passed through, how long each step took, and exactly where it stopped.</p>
            <p>No new agent inside your code, no tracing SDK to learn, no request bodies read. One package, one start line, and the agent on your server.</p>
            <p>backwork is a hosted service. We run it, keep it up and back it up, so your team spends its time on the answer rather than the tooling.</p>
          </div>
        </Wrap>
      </section>
      <section className="border-b border-border bg-surface">
        <Wrap className="grid gap-5 py-14 sm:py-20 md:grid-cols-3">
          {VALUES.map(({ icon: Icon, title, body }) => (
            <div key={title} className="rounded-2xl border border-border bg-bg p-6">
              <Icon className="h-5 w-5 text-muted" />
              <h2 className="mt-4 text-[17px] font-semibold">{title}</h2>
              <p className="mt-2 text-[14.5px] leading-relaxed text-muted">{body}</p>
            </div>
          ))}
        </Wrap>
      </section>
      <CtaBand />
    </MarketingShell>
  );
}
