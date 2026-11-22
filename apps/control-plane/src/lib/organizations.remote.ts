import { form } from "$app/server";
import { createOrganizationInput } from "@platform/contracts";
import { invalid, redirect } from "@sveltejs/kit";
import { getRuntime } from "#server/runtime";
import { requireLogin } from "#server/page-auth";
import { sessionSignIn } from "#server/identity";
import { localDestination } from "#server/navigation";
import { chosenDestination, organizationPlaceholder, workspacePath } from "#lib/workspace-path";
import { z } from "zod";
import { InvalidOperation } from "#server/errors";

export const createOrganization = form(
  createOrganizationInput.extend({ next: z.string().optional() }),
  async ({ next, ...input }) => {
    const { user, session } = requireLogin("/organizations");
    const runtime = await getRuntime();

    const organization = await runtime.onboarding
      .create(sessionSignIn(user, session), input)
      .catch((cause: unknown) => {
        if (cause instanceof InvalidOperation) invalid(cause.message);
        throw cause;
      });

    const destination = localDestination(next);

    // A new organization starts on its welcome page unless the chooser was opened for a page.
    redirect(
      303,
      destination === "/" || destination === workspacePath(organizationPlaceholder)
        ? workspacePath(organization.slug, "/welcome")
        : chosenDestination(destination, organization.slug),
    );
  },
);
