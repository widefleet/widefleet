import { command, form, getRequestEvent } from "$app/server";
import { organizationSelection, createOrganizationInput } from "@platform/contracts";
import { error, redirect } from "@sveltejs/kit";
import { getRuntime } from "#server/runtime";
import { identityFailure } from "#server/page-auth";
import { localDestination } from "#server/navigation";
import { z } from "zod";
import { remoteOperation } from "#server/remote-support";

export const createOrganization = command(createOrganizationInput, async (input) => {
  const { request } = getRequestEvent();
  const runtime = await getRuntime();
  const person = await runtime.identity.authenticateUser(request, "platform:write");

  if (person.isErr()) return identityFailure(person.error, request);
  const organization = await remoteOperation(() => runtime.onboarding.create(person.value, input));
  const selection = await runtime.identity.selectOrganization(request, organization.id);

  if (selection.isErr()) return identityFailure(selection.error, request);

  return organization;
});

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
