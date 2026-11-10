import { form, getRequestEvent } from "$app/server";
import { organizationSelection, createOrganizationInput } from "@platform/contracts";
import { error, invalid, redirect } from "@sveltejs/kit";
import { getRuntime } from "#server/runtime";
import { requireLogin, pageFailure } from "#server/page-auth";
import { localDestination } from "#server/navigation";
import { z } from "zod";
import { InvalidOperation } from "#server/errors";

export const createOrganization = form(
  createOrganizationInput.extend({ next: z.string().optional() }),
  async ({ next, ...input }) => {
    const { request } = getRequestEvent();
    const { user, session } = requireLogin("/organizations");
    const runtime = await getRuntime();

    const organization = await runtime.onboarding
      .create(
        {
          userId: user.id,
          identityOrganizationId: session.identityOrganizationId ?? null,
        },
        input,
      )
      .catch((cause: unknown) => {
        if (cause instanceof InvalidOperation) invalid(cause.message);
        throw cause;
      });

    const selection = await runtime.identity.selectOrganization(request, organization.id);

    if (selection.isErr()) pageFailure(selection.error);
    const destination = localDestination(next);
    redirect(303, destination === "/" ? "/welcome" : destination);
  },
);

export const selectOrganization = form(
  organizationSelection.extend({ next: z.string().optional() }),
  async ({ organizationId, next }) => {
    const { request } = getRequestEvent();

    // Organization choice is a browser-session preference. API tokens select per request.
    if (request.headers.has("authorization"))
      error(400, "Use a browser session to select an organization");
    requireLogin("/organizations");
    const runtime = await getRuntime();
    const result = await runtime.identity.selectOrganization(request, organizationId);

    if (result.isErr()) return pageFailure(result.error);

    const destination = localDestination(next);

    if (!getRequestEvent().isRemoteRequest) redirect(303, destination);

    return { selected: true, next: destination };
  },
);
