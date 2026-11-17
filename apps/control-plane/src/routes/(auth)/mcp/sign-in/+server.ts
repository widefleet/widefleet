import { redirect, error } from "@sveltejs/kit";
import { z } from "zod";
import { pagePrincipal, requireLogin } from "#server/page-auth";
import { getRuntime } from "#server/runtime";
import type { RequestHandler } from "./$types";

// This only supplies organization context. The data plane subsequently obtains
// and verifies the normal organization's OAuth grant before issuing an MCP token.
export const GET: RequestHandler = async ({ url }) => {
  const state = z
    .string()
    .regex(/^[A-Za-z0-9_-]{43}$/)
    .safeParse(url.searchParams.get("state"));

  if (!state.success) error(400, "Start sign-in from your connected app.");
  requireLogin(url.pathname + url.search);
  const principal = await pagePrincipal();
  const { configuration } = await getRuntime();
  const port = configuration.APP_HTTPS_PORT === 443 ? "" : `:${configuration.APP_HTTPS_PORT}`;
  const target = new URL(`https://mcp.${configuration.APP_DOMAIN}${port}/oauth/organization`);
  target.searchParams.set("state", state.data);
  target.searchParams.set("organization", principal.application.organizationId);
  redirect(303, target.href, { external: [target.origin] });
};
