import { APIError } from "better-auth/api";
import { getRequestEvent } from "$app/server";
import { error, invalid, redirect } from "@sveltejs/kit";
import type { Result } from "better-result";
import { DatabaseUnavailable, InvalidOperation, StorageUnavailable } from "./errors.ts";
import { pageFailure } from "./page-auth.ts";
import { getRuntime, reportRequestException } from "./runtime.ts";

type Denial = { location: string; status: number; message: string };

const authorize = async (deny: (denial: Denial) => never, write?: { organizationId: string }) => {
  const { request, locals } = getRequestEvent();
  const { user, session } = locals;

  if (!user || !session)
    return deny({ location: "/sign-in", status: 401, message: "Sign in to continue" });
  const runtime = await getRuntime();

  const principal = await runtime.identity.principal(
    user.id,
    session.activeOrganizationId ?? null,
    session.identityOrganizationId ?? null,
    session.id,
  );

  if (principal.isErr()) {
    if (principal.error instanceof DatabaseUnavailable) return pageFailure(principal.error);

    const { code, message, organizationSlug } = principal.error;

    if (code === "CONFLICT") error(409, message);

    if (code === "UNAUTHORIZED") return deny({ location: "/sign-in", status: 401, message });

    if (code === "SSO_REQUIRED")
      return deny({
        location: `/sign-in?${new URLSearchParams({ organization: organizationSlug ?? "" })}`,
        status: 403,
        message,
      });

    // A stale selection can be repaired without signing out of a valid session.
    return deny({ location: "/organizations", status: 403, message });
  }

  if (write && write.organizationId !== principal.value.application.organizationId)
    error(409, "Your organization selection changed. Reload this page before making changes.");

  runtime.reporting.active(principal.value.id);
  session.activeOrganizationId = principal.value.application.organizationId;

  return { runtime, principal: principal.value, request };
};

// Queries and forms send a caller without access to where the page hook would send them. A query
// request does not name its page, so these destinations carry no return path.
export const remoteContext = (write?: { organizationId: string }) =>
  authorize(({ location }) => redirect(303, location), write);

// Commands cannot redirect, so they report the same denial as an error.
export const commandContext = (write?: { organizationId: string }) =>
  authorize(({ status, message }) => error(status, message), write);

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
