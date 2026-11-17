import { form, query, getRequestEvent } from "$app/server";
import { invalid, redirect } from "@sveltejs/kit";
import { APIError } from "better-auth/api";
import { organizationSelection, userConnectionInput } from "@platform/contracts";
import { z } from "zod";
import { InvalidOperation } from "#server/errors";
import { remoteContext } from "#server/remote-support";
import { connectionOnboardingCookie } from "#server/connection-onboarding";

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
  onboarding: z.enum(["true", "false"]).default("false"),
});

export const prepareUserConnection = form(input, async ({ appId, organizationId, onboarding }) => {
  const { runtime, principal } = await remoteContext({ organizationId });
  let destination: string;

  try {
    destination = (await runtime.userConnections.prepare(principal, appId, onboarding === "true"))
      .url;
  } catch (cause) {
    if (cause instanceof APIError || cause instanceof InvalidOperation) invalid(cause.message);
    throw cause;
  }

  redirect(303, destination);
});

export const disconnectUserConnection = form(
  input,
  async ({ appId, organizationId, onboarding }) => {
    const { runtime, principal } = await remoteContext({ organizationId });

    try {
      await runtime.userConnections.disconnect(principal, appId);
    } catch (cause) {
      if (cause instanceof APIError || cause instanceof InvalidOperation) invalid(cause.message);
      throw cause;
    }

    redirect(303, onboarding === "true" ? "/connections?onboarding=1" : "/connections");
  },
);

export const finishConnectionOnboarding = form(
  organizationSelection,
  async ({ organizationId }) => {
    const { principal } = await remoteContext({ organizationId });
    getRequestEvent().cookies.set(
      await connectionOnboardingCookie(principal.id, organizationId),
      "1",
      { path: "/", httpOnly: true, sameSite: "lax", maxAge: 365 * 24 * 60 * 60 },
    );
    redirect(303, "/catalog");
  },
);
