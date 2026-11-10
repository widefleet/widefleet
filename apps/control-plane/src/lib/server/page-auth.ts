import { APIError } from "better-auth/api";
import { getRequestEvent } from "$app/server";
import { error, redirect } from "@sveltejs/kit";
import type { DatabaseUnavailable, InvalidOperation, StorageUnavailable } from "./errors.ts";
import { getRuntime } from "./runtime.ts";
import type { AuthenticationFailed } from "./identity.ts";
import { runExtensionEffect } from "../extension-effects.ts";

export const requireLogin = (destination?: string) => {
  const { locals, url } = getRequestEvent();

  if (!locals.user || !locals.session)
    redirect(
      303,
      `/sign-in?${new URLSearchParams({ next: destination ?? url.pathname + url.search })}`,
    );

  return { user: locals.user, session: locals.session };
};

export const pageOrganizations = async () => {
  const { user, session } = requireLogin();
  const runtime = await getRuntime();

  const result = await runtime.identity.listOrganizations(
    user.id,
    session.identityOrganizationId ?? null,
  );

  if (result.isErr()) return pageFailure(result.error);

  return result.value;
};

export const invitationIdentity = async (invitationId: string) => {
  const { locals } = getRequestEvent();
  const runtime = await getRuntime();
  const company = await runtime.invitations.companySignIn(invitationId);

  if (company && locals.session?.identityOrganizationId !== company.id)
    redirect(
      303,
      `/sign-in?${new URLSearchParams({ organization: company.slug, next: `/invitations/${invitationId}` })}`,
    );

  const { user, session } = requireLogin(`/invitations/${invitationId}`);

  return { userId: user.id, identityOrganizationId: session.identityOrganizationId ?? null };
};

export const pagePrincipal = async () => {
  const { user, session } = requireLogin();
  const { url } = getRequestEvent();
  const runtime = await getRuntime();

  const result = await runtime.identity.principal(
    user.id,
    session.activeOrganizationId ?? null,
    session.identityOrganizationId ?? null,
  );

  if (result.isOk()) {
    runtime.reporting.active(result.value.id);

    return result.value;
  }

  const cause = result.error;

  if (cause._tag === "DatabaseUnavailable") return pageFailure(cause);

  if (cause.code === "SSO_REQUIRED")
    redirect(
      303,
      `/sign-in?${new URLSearchParams({ organization: cause.organizationSlug ?? "", next: url.pathname + url.search })}`,
    );

  // A stale selection can be repaired without signing out of a valid session.
  if (cause.code === "ORGANIZATION_REQUIRED" || cause.code === "FORBIDDEN")
    redirect(303, `/organizations?${new URLSearchParams({ next: url.pathname + url.search })}`);

  return pageFailure(cause);
};

const operationStatus = {
  NOT_FOUND: 404,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  ORGANIZATION_REQUIRED: 403,
  SSO_REQUIRED: 403,
  CONFLICT: 409,
  BAD_REQUEST: 400,
};

export const pageFailure = (
  cause:
    | DatabaseUnavailable
    | InvalidOperation
    | StorageUnavailable
    | AuthenticationFailed
    | APIError,
): never => {
  if (cause instanceof APIError) {
    if (cause.statusCode >= 500)
      runExtensionEffect(async () => {
        (await getRuntime()).reporting.exception(cause);
      });
    error(cause.statusCode, cause.message);
  }

  if (cause._tag === "DatabaseUnavailable" || cause._tag === "StorageUnavailable")
    runExtensionEffect(async () => {
      (await getRuntime()).reporting.exception(cause.cause instanceof Error ? cause.cause : cause);
    });

  if (cause._tag === "DatabaseUnavailable") error(503, "The database is temporarily unavailable.");

  if (cause._tag === "StorageUnavailable") error(503, "File storage is temporarily unavailable.");
  error(operationStatus[cause.code], cause.message);
};
