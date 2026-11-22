import { APIError } from "better-auth/api";
import { getRequestEvent } from "$app/server";
import { error, invalid, redirect } from "@sveltejs/kit";
import type { Result } from "better-result";
import { DatabaseUnavailable, InvalidOperation, StorageUnavailable } from "./errors.ts";
import { pageFailure } from "./page-auth.ts";
import { getRuntime, reportRequestException } from "./runtime.ts";

type Denial = { location: string; status: number; message: string };

// Remote functions receive their page's organization as an argument. A query is cached by its
// arguments, so it cannot read the organization from the page URL, and the session's
// organization may belong to another tab.
const authorize = async (
  deny: (denial: Denial) => never,
  { organizationId }: { organizationId: string },
) => {
  const { request, locals } = getRequestEvent();
  const { user, session } = locals;

  if (!user || !session)
    return deny({ location: "/sign-in", status: 401, message: "Sign in to continue" });
  const runtime = await getRuntime();

  const member = await runtime.identity.member(
    user.id,
    { organizationId },
    session.identityOrganizationId ?? null,
  );

  if (member.isErr()) {
    if (member.error instanceof DatabaseUnavailable) return pageFailure(member.error);

    const { code, message, organizationSlug } = member.error;

    if (code === "UNAUTHORIZED") return deny({ location: "/sign-in", status: 401, message });

    if (code === "SSO_REQUIRED")
      return deny({
        location: `/sign-in?${new URLSearchParams({ organization: organizationSlug ?? "" })}`,
        status: 403,
        message,
      });

    // Membership can end while a page is open. Choosing another organization repairs it.
    return deny({ location: "/organizations", status: 403, message });
  }

  runtime.reporting.active(member.value.principal.id);

  return { runtime, ...member.value, request };
};

// Queries and forms send a caller without access to where the page hook would send them. A query
// request does not name its page, so these destinations carry no return path.
export const remoteContext = (selection: { organizationId: string }) =>
  authorize(({ location }) => redirect(303, location), selection);

// Commands cannot redirect, so they report the same denial as an error.
export const commandContext = (selection: { organizationId: string }) =>
  authorize(({ status, message }) => error(status, message), selection);

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
