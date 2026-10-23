import { error, json } from "@sveltejs/kit";
import { getRuntime } from "#server/runtime";
import { cloudPlatformUrl, companyDomain } from "#server/platform-discovery";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async ({ url, setHeaders }) => {
  setHeaders({ "cache-control": "private, no-store" });
  const runtime = await getRuntime();

  if (runtime.configuration.PLATFORM_URL !== cloudPlatformUrl) error(404);
  const domain = companyDomain.safeParse(url.searchParams.get("domain"));

  if (!domain.success) error(400, "Enter a company domain such as example.com");

  try {
    return json({ platform_url: await runtime.discoverPlatform(domain.data) });
  } catch {
    error(503, "Could not determine your company's platform. Retry or use its direct URL.");
  }
};
