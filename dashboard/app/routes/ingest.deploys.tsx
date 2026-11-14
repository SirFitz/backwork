import type { ActionFunctionArgs } from "@remix-run/node";
import { handleDeployIngest } from "~/lib/deploys.server";

// POST /ingest/deploys (BAC-73): a CI job or a post-deployment command reports a deploy with the
// project's ingest token, so charts can mark it. Body: one report or { deploys: [...] }, at most
// 20; see `DeployReport` in lib/deploys.ts. Answers { accepted: n }.
export function action({ request }: ActionFunctionArgs): Promise<Response> {
  return handleDeployIngest(request);
}

export function loader(): Response {
  return new Response(JSON.stringify({ error: "method not allowed" }), {
    status: 405,
    headers: { "content-type": "application/json", allow: "POST" },
  });
}
