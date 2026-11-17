import { getRequestEvent } from "$app/server";

export type { Runtime } from "./runtime-services.ts";

export const getRuntime = () => getRequestEvent().locals.runtime();

export const reportRequestException = async (error: Error, locals = getRequestEvent().locals) => {
  const runtime = await locals.runtime();
  runtime.reporting.exception(error, locals.user ? `user:${locals.user.id}` : undefined, {
    $groups:
      locals.user && locals.session?.activeOrganizationId
        ? { organization: locals.session.activeOrganizationId }
        : undefined,
  });
};
