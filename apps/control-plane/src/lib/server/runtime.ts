import { getRequestEvent } from "$app/server";

export type { Runtime } from "./runtime-services.ts";

export const getRuntime = () => getRequestEvent().locals.runtime();

export const reportRequestException = async (error: Error, locals = getRequestEvent().locals) => {
  const runtime = await locals.runtime();
  const principal = locals.principal?.id === locals.user?.id ? locals.principal : undefined;

  const organizationId =
    principal?.application.organizationId ?? locals.session?.activeOrganizationId;

  runtime.reporting.exception(error, locals.user ? `user:${locals.user.id}` : undefined, {
    $groups: locals.user && organizationId ? { organization: organizationId } : undefined,
  });
};
