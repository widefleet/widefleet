import { error, redirect } from "@sveltejs/kit";
import type { DatabaseUnavailable, InvalidOperation, StorageUnavailable } from "./errors.ts";
import { getRuntime } from "./runtime.ts";
import { AuthenticationFailed } from "./identity.ts";
import { runExtensionEffect } from "../extension-effects.ts";

const chooseOrganization = (request: Request): never => {
  const url = new URL(request.url);
  redirect(303, `/organizations?next=${encodeURIComponent(url.pathname + url.search)}`);
};

export const identityFailure = (
  cause: AuthenticationFailed | DatabaseUnavailable,
  request: Request,
): never => {
  if (cause._tag === "DatabaseUnavailable") {
    runExtensionEffect(async () => {
      (await getRuntime()).reporting.exception(cause.cause instanceof Error ? cause.cause : cause);
    });
    error(503, "Sign-in is temporarily unavailable.");
  }

  if (cause.code === "SSO_REQUIRED") {
    const url = new URL(request.url);
    redirect(
      303,
      `/sign-in?${new URLSearchParams({ organization: cause.organizationSlug ?? "", next: url.pathname + url.search })}`,
    );
  }

  if (cause.code === "ORGANIZATION_REQUIRED") chooseOrganization(request);

  if (cause.code === "CONFLICT") error(409, cause.message);

  if (cause.code === "FORBIDDEN") error(403, cause.message);
  const url = new URL(request.url);
  redirect(303, `/sign-in?next=${encodeURIComponent(url.pathname + url.search)}`);
};

export const pageOrganizations = async (request: Request) => {
  const runtime = await getRuntime();
  const result = await runtime.identity.organizations(request);

  if (result.isErr()) return identityFailure(result.error, request);

  return result.value;
};

export const invitationIdentity = async (request: Request, invitationId: string, write = false) => {
  const runtime = await getRuntime();

  const verified = await runtime.identity.authenticateUser(
    request,
    write ? "platform:write" : "platform:read",
  );

  if (
    verified.isErr() &&
    (verified.error._tag === "DatabaseUnavailable" || verified.error.code !== "UNAUTHORIZED")
  )
    return identityFailure(verified.error, request);
  const company = await runtime.invitations.companySignIn(invitationId);

  if (company && (verified.isErr() || verified.value.identityOrganizationId !== company.id))
    redirect(
      303,
      `/sign-in?${new URLSearchParams({ organization: company.slug, next: `/invitations/${invitationId}` })}`,
    );

  return verified.isErr() ? identityFailure(verified.error, request) : verified.value;
};

export const pagePrincipal = async (request: Request, write = false) => {
  const runtime = await getRuntime();

  const result = await runtime.identity.authenticate(
    request,
    write ? "platform:write" : "platform:read",
  );

  if (result.isOk()) {
    runtime.reporting.active(result.value.id);

    return result.value;
  }

  // A stale selection can be repaired without signing out of a valid session.
  if (result.error._tag === "AuthenticationFailed" && result.error.code === "FORBIDDEN" && !write) {
    await pageOrganizations(request);
    chooseOrganization(request);
  }

  return identityFailure(result.error, request);
};

const operationStatus = { NOT_FOUND: 404, FORBIDDEN: 403, CONFLICT: 409, BAD_REQUEST: 400 };

export const pageFailure = (
  cause: DatabaseUnavailable | InvalidOperation | StorageUnavailable,
): never => {
  if (cause._tag !== "InvalidOperation")
    runExtensionEffect(async () => {
      (await getRuntime()).reporting.exception(cause.cause instanceof Error ? cause.cause : cause);
    });

  if (cause._tag === "DatabaseUnavailable") error(503, "The database is temporarily unavailable.");

  if (cause._tag === "StorageUnavailable") error(503, "File storage is temporarily unavailable.");
  error(operationStatus[cause.code], cause.message);
};
