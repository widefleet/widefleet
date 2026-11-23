import { redirect, error } from "@sveltejs/kit";
import { z } from "zod";
import { organizationMember, pageOrganizations, requireLogin } from "#server/page-auth";
import { organizationPlaceholder } from "#lib/workspace-path";
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

  // A person with several organizations chooses which one the client connects. The chooser
  // returns here with that organization in the address.
  const organizations = await pageOrganizations();
  const requested = url.searchParams.get("organization");

  const chosen = requested
    ? organizations.find((organization) => organization.slug === requested)
    : organizations.length === 1
      ? organizations[0]
      : undefined;

  if (!chosen) {
    const next = `${url.pathname}?${new URLSearchParams({ state: state.data })}&organization=${organizationPlaceholder}`;
    redirect(303, `/organizations?${new URLSearchParams({ next })}`);
  }

  const { principal } = await organizationMember(chosen.slug);
  const { configuration } = await getRuntime();
  const port = configuration.APP_HTTPS_PORT === 443 ? "" : `:${configuration.APP_HTTPS_PORT}`;
  const target = new URL(`https://mcp.${configuration.APP_DOMAIN}${port}/oauth/organization`);
  target.searchParams.set("state", state.data);
  target.searchParams.set("organization", principal.application.organizationId);
  redirect(303, target.href, { external: [target.origin] });
};
