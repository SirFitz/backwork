import type { LoaderFunctionArgs, MetaFunction } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import { getUser } from "~/lib/auth/context.server";
import { MarketingShell, seo, LegalArticle } from "~/components/marketing";

export const meta: MetaFunction = () =>
  seo({ title: "Privacy Policy — backwork", description: "How backwork handles data: we process only what is needed to run your account and follow your requests, filter sensitive data at the source, and never sell data or track you for ads.", path: "/privacy" });

export async function loader({ request }: LoaderFunctionArgs) {
  return json({ authed: !!(await getUser(request)) });
}

const SECTIONS: [string, string[]][] = [
  ["Who this covers", [
    "This policy covers backwork, the hosted service at backwork.dev, and explains how we handle the data you and your services send us.",
  ]],
  ["What we process", [
    "Account data: your name, email address, organization and team membership, and a securely hashed password. We use this to authenticate you and operate your account.",
    "Data your services send us: log lines, request paths and timings, and any IDs or fields your code chooses to record. You are the controller of this data; we process it on your behalf and keep it to your organization. Request and response bodies are never collected, and our agent removes card numbers, email addresses, phone numbers, passwords, API keys, tokens and any patterns you add before data leaves your servers.",
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
    "Account data is kept while your account is active. Data your services send is kept for your plan's retention period and then deleted. When you close your account, we delete everything within 30 days. You can ask us to delete your account and its data at any time.",
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
      <LegalArticle title="Privacy Policy" effective="November 12, 2026" sections={SECTIONS} />
    </MarketingShell>
  );
}
