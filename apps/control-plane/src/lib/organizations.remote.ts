import { form, getRequestEvent } from "$app/server";
import { organizationSelection } from "@platform/contracts";
import { error, redirect } from "@sveltejs/kit";
import { getRuntime } from "#server/runtime";
import { identityFailure } from "#server/page-auth";
import { localDestination } from "#server/navigation";
import { z } from "zod";

export const selectOrganization = form(
  organizationSelection.extend({ next: z.string().optional() }),
  async ({ organizationId, next }) => {
    const { request } = getRequestEvent();

    // Organization choice is a browser-session preference. API tokens select per request.
    if (request.headers.has("authorization"))
      error(400, "Use a browser session to select an organization");
    const runtime = await getRuntime();
    const result = await runtime.identity.selectOrganization(request, organizationId);

    if (result.isErr()) return identityFailure(result.error, request);

    const destination = localDestination(next);

    if (!getRequestEvent().isRemoteRequest) redirect(303, destination);

    return { selected: true, next: destination };
  },
);
