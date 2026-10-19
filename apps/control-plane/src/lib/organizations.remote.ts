import { form, getRequestEvent } from "$app/server";
import { organizationSelection } from "@platform/contracts";
import { error, redirect } from "@sveltejs/kit";
import { getRuntime } from "#server/runtime";
import { identityFailure } from "#server/page-auth";

export const selectOrganization = form(organizationSelection, async ({ organizationId }) => {
  const { request } = getRequestEvent();

  // Organization choice is a browser-session preference. API tokens select per request.
  if (request.headers.has("authorization"))
    error(400, "Use a browser session to select an organization");
  const runtime = await getRuntime();
  const result = await runtime.identity.selectOrganization(request, organizationId);

  if (result.isErr()) return identityFailure(result.error, request);

  if (!getRequestEvent().isRemoteRequest) redirect(303, "/");

  return { selected: true };
});
