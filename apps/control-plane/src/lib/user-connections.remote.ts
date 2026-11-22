import { form, query } from "$app/server";
import { invalid, redirect } from "@sveltejs/kit";
import { APIError } from "better-auth/api";
import { organizationSelection, userConnectionInput } from "@platform/contracts";
import { z } from "zod";
import { InvalidOperation } from "#server/errors";
import { remoteContext } from "#server/remote-support";
import { workspacePath } from "#lib/workspace-path";

export const getUserConnections = query(organizationSelection, async (selection) => {
  const { runtime, principal } = await remoteContext(selection);

  try {
    return { connections: await runtime.userConnections.list(principal), error: null };
  } catch (cause) {
    // A refused identity, such as a recovery session without a company account,
    // explains itself; other failures are temporary.
    if (cause instanceof APIError)
      return {
        connections: [],
        error:
          cause.statusCode === 403
            ? { kind: "refused" as const, message: cause.message }
            : { kind: "unavailable" as const, message: null },
      };
    throw cause;
  }
});

const input = userConnectionInput.extend({
  ...organizationSelection.shape,
  id: z.uuid().optional(),
});

export const prepareUserConnection = form(input, async ({ appId, organizationId }) => {
  const { runtime, principal } = await remoteContext({ organizationId });
  let destination: string;

  try {
    destination = (await runtime.userConnections.prepare(principal, appId)).url;
  } catch (cause) {
    if (cause instanceof APIError || cause instanceof InvalidOperation) invalid(cause.message);
    throw cause;
  }

  // The runtime only returns launch links on the connector's own origin.
  redirect(303, destination, { external: [new URL(destination).origin] });
});

export const disconnectUserConnection = form(input, async ({ appId, organizationId }) => {
  const { runtime, principal, organization } = await remoteContext({ organizationId });

  try {
    await runtime.userConnections.disconnect(principal, appId);
  } catch (cause) {
    if (cause instanceof APIError || cause instanceof InvalidOperation) invalid(cause.message);
    throw cause;
  }

  redirect(303, workspacePath(organization.slug, "/connections"));
});
