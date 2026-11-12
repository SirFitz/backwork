// The request view moved to /requests/$id (2026-11-12, stack slimmed: no Jaeger).
// Old links keep working through this redirect, query string included.
import type { LoaderFunctionArgs } from "@remix-run/node";
import { redirect } from "@remix-run/node";

export function loader({ request, params }: LoaderFunctionArgs) {
  const url = new URL(request.url);
  throw redirect(`/requests/${encodeURIComponent(params.id ?? "")}${url.search}`, 301);
}
