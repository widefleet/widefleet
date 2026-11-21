import { APIError } from "better-auth/api";
import { getRequestEvent } from "$app/server";
import { error, invalid } from "@sveltejs/kit";
import type { Result } from "better-result";
import { DatabaseUnavailable, InvalidOperation, StorageUnavailable } from "./errors.ts";
import { getUserSession, pageFailure } from "./page-auth.ts";
import { getRuntime, reportRequestException } from "./runtime.ts";

export const remoteContext = async (write?: { organizationId: string }) => {
  const { request } = getRequestEvent();
  const { user, session } = getUserSession();
  const runtime = await getRuntime();

  const principal = await runtime.identity.principal(
    user.id,
    session.activeOrganizationId ?? null,
    session.identityOrganizationId ?? null,
    session.id,
  );

  if (principal.isErr()) {
    if (principal.error instanceof DatabaseUnavailable) return pageFailure(principal.error);

    const { code, message } = principal.error;

    if (code === "CONFLICT") error(409, message);

    if (code === "UNAUTHORIZED") error(401, message);

    if (code === "SSO_REQUIRED") error(403, { message, code });

    // A forbidden principal means the shared organization selection is no longer available.
    error(403, { message, code: "ORGANIZATION_REQUIRED" });
  }

  if (write && write.organizationId !== principal.value.application.organizationId)
    error(409, "Your organization selection changed. Reload this page before making changes.");

  runtime.reporting.active(principal.value.id);
  session.activeOrganizationId = principal.value.application.organizationId;

  return { runtime, principal: principal.value, request };
};

export const queryValue = <T>(
  result: Result<T, InvalidOperation | DatabaseUnavailable | StorageUnavailable | APIError>,
) => {
  if (result.isErr()) return pageFailure(result.error);

  return result.value;
};

export const formValue = <T>(
  result: Result<T, InvalidOperation | DatabaseUnavailable | StorageUnavailable | APIError>,
) => {
  if (result.isErr()) {
    if (result.error instanceof InvalidOperation) invalid(result.error.message);

    return pageFailure(result.error);
  }

  return result.value;
};

export const remoteOperation = async <T>(operation: () => Promise<T>) => {
  try {
    return await operation();
  } catch (cause) {
    if (cause instanceof InvalidOperation) pageFailure(cause);

    if (cause instanceof APIError) {
      if (cause.statusCode >= 500) await reportRequestException(cause);
      error(cause.statusCode, cause.message);
    }

    throw cause;
  }
};
