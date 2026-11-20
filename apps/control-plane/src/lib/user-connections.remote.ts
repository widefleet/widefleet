import { form, query } from "$app/server";
import { invalid, redirect } from "@sveltejs/kit";
import { APIError } from "better-auth/api";
import { organizationSelection, userConnectionInput } from "@platform/contracts";
import { z } from "zod";
import { InvalidOperation } from "#server/errors";
import { remoteContext } from "#server/remote-support";

export const getUserConnections = query(async () => {
  const { runtime, principal } = await remoteContext();

  try {
    return { connections: await runtime.userConnections.list(principal), error: null };
  } catch (cause) {
    if (cause instanceof APIError)
      return {
        connections: [],
        error: cause.statusCode === 401 ? ("sign_in" as const) : ("unavailable" as const),
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
  const { runtime, principal } = await remoteContext({ organizationId });

  try {
    await runtime.userConnections.disconnect(principal, appId);
  } catch (cause) {
    if (cause instanceof APIError || cause instanceof InvalidOperation) invalid(cause.message);
    throw cause;
  }

  redirect(303, "/connections");
});
