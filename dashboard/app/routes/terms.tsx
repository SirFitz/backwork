import type { LoaderFunctionArgs, MetaFunction } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import { getUser } from "~/lib/auth/context.server";
import { MarketingShell, seo, LegalArticle } from "~/components/marketing";

export const meta: MetaFunction = () =>
  seo({ title: "Terms of Service — backwork", description: "The terms governing use of the backwork managed service and the open-source project.", path: "/terms" });

export async function loader({ request }: LoaderFunctionArgs) {
  return json({ authed: !!(await getUser(request)) });
}

const SECTIONS: [string, string[]][] = [
  ["Acceptance", [
    "By accessing or using the backwork managed service at backwork.dev (the “Service”), you agree to these Terms. If you're using the Service on behalf of an organization, you agree on its behalf.",
  ]],
  ["The service", [
    "backwork is offered both as open-source software you may self-host and as a managed cloud Service. The self-hosted software is governed by the license in its source repository; these Terms govern the managed Service.",
  ]],
  ["Accounts", [
    "You're responsible for your account, for keeping your credentials and ingest tokens secret, and for the activity that occurs under them. Provide accurate information and keep it current.",
  ]],
  ["Acceptable use", [
    "Don't use the Service to break the law, infringe others' rights, transmit malware, attempt to access other tenants' data, probe or disrupt the Service, or exceed reasonable resource limits in a way that degrades it for others.",
  ]],
  ["Your data", [
    "You retain all rights to the telemetry and content you send. You grant us only the limited rights needed to operate the Service for you. You're responsible for ensuring you have the right to send us that data.",
  ]],
  ["Plans, trials & changes", [
    "Paid plans, where applicable, are billed as described at sign-up. We may change features or pricing with reasonable notice. Free and trial tiers are provided as-is and may change or end.",
  ]],
  ["Availability", [
    "We work to keep the Service reliable but, except where a written SLA applies (Enterprise), it is provided without an availability guarantee.",
  ]],
  ["Disclaimer of warranties", [
    "The Service is provided “AS IS” and “AS AVAILABLE,” without warranties of any kind, whether express or implied, including merchantability, fitness for a particular purpose, and non-infringement.",
  ]],
  ["Limitation of liability", [
    "To the maximum extent permitted by law, backwork will not be liable for any indirect, incidental, special, consequential or punitive damages, or for lost profits or data, arising from your use of the Service.",
  ]],
  ["Termination", [
    "You may stop using the Service at any time. We may suspend or terminate access for breach of these Terms or to protect the Service. On termination, your right to use the Service ends.",
  ]],
  ["Changes to these terms", [
    "We may update these Terms; material changes take effect on the updated effective date below. Continued use after changes constitutes acceptance.",
  ]],
  ["Contact", [
    "Questions about these Terms? Email hello@backwork.dev.",
  ]],
];

export default function Terms() {
  const { authed } = useLoaderData<typeof loader>();
  return (
    <MarketingShell authed={authed}>
      <LegalArticle title="Terms of Service" effective="June 10, 2026" sections={SECTIONS} />
    </MarketingShell>
  );
}
