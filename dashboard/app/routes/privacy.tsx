import type { LoaderFunctionArgs, MetaFunction } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import { getUser } from "~/lib/auth/context.server";
import { MarketingShell, seo, LegalArticle } from "~/components/marketing";

export const meta: MetaFunction = () =>
  seo({ title: "Privacy Policy — backwork", description: "How backwork handles data: self-hosted telemetry stays on your infrastructure; for the managed cloud we process only what's needed to run your account. No selling, no ad tracking.", path: "/privacy" });

export async function loader({ request }: LoaderFunctionArgs) {
  return json({ authed: !!(await getUser(request)) });
}

const SECTIONS: [string, string[]][] = [
  ["Who this covers", [
    "backwork is available two ways: as open-source software you self-host, and as a managed cloud service at backwork.dev. This policy explains how we handle data in each case.",
    "When you self-host backwork, your telemetry stays entirely on your own infrastructure — we never receive or have access to it.",
  ]],
  ["What we process (managed cloud)", [
    "Account data: your name, email address, organization and team membership, and a securely hashed password. We use this to authenticate you and operate your account.",
    "Telemetry you send us: when you use the managed cloud, the logs, metrics and traces you ship are stored to provide the service. You are the controller of this data; we process it on your behalf and isolate it to your organization.",
    "Operational data: minimal request logs and metrics about the service itself, used to keep it secure and reliable.",
  ]],
  ["Cookies", [
    "We use only essential cookies: a signed, HttpOnly session cookie to keep you logged in, and a small cookie that remembers your light/dark theme. We do not use advertising or third-party tracking cookies.",
  ]],
  ["How we use data", [
    "To provide and secure the service, authenticate you, deliver alerts you configure, and respond to support requests. We do not sell your data, and we do not use your telemetry for advertising.",
  ]],
  ["Sharing & subprocessors", [
    "We share data only with infrastructure subprocessors strictly necessary to run the managed service (e.g. hosting and transactional email for alerts and account notices), under appropriate confidentiality terms. We never sell personal data.",
  ]],
  ["Retention", [
    "Account data is kept while your account is active. Telemetry on the managed cloud is retained according to your plan's retention window and then deleted. You can request deletion of your account and associated data at any time.",
  ]],
  ["Security", [
    "We apply per-tenant isolation, encryption of secrets at rest, hashed credentials and tokens, and hardened sessions. See our Security page for details.",
  ]],
  ["Your rights", [
    "You may access, correct, export or delete your personal data. To exercise these rights, contact us at privacy@backwork.dev.",
  ]],
  ["Children", [
    "backwork is not directed to children and is not intended for anyone under 16.",
  ]],
  ["Changes", [
    "We may update this policy; material changes will be reflected by the effective date below and, where appropriate, announced in-product.",
  ]],
  ["Contact", [
    "Questions about privacy? Email privacy@backwork.dev.",
  ]],
];

export default function Privacy() {
  const { authed } = useLoaderData<typeof loader>();
  return (
    <MarketingShell authed={authed}>
      <LegalArticle title="Privacy Policy" effective="June 10, 2026" sections={SECTIONS} />
    </MarketingShell>
  );
}
