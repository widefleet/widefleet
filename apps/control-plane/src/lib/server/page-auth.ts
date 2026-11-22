import { APIError } from "better-auth/api";
import { getRequestEvent } from "$app/server";
import { error, redirect } from "@sveltejs/kit";
import type { DatabaseUnavailable, InvalidOperation, StorageUnavailable } from "./errors.ts";
import { getRuntime, reportRequestException } from "./runtime.ts";
import type { AuthenticationFailed } from "./identity.ts";
import { runExtensionEffect } from "../extension-effects.ts";

// Remote functions are independently callable and do not inherit page groups.
// Data access reads the hook's session and rejects calls without an identity.
export const getUserSession = () => {
  const { user, session } = getRequestEvent().locals;

  if (!user || !session) error(401, "Sign in to continue");

  return { user, session };
};

// Remote forms can run without a page route, including after a session expires.
export const requireLogin = (destination: string) => {
  const { locals } = getRequestEvent();

  if (!locals.user || !locals.session)
    redirect(303, `/sign-in?${new URLSearchParams({ next: destination })}`);

  return { user: locals.user, session: locals.session };
};

export const pageOrganizations = async () => {
  const { user, session } = getUserSession();
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

const requestDestination = () => {
  const { url, request } = getRequestEvent();

  // Like the sign-in redirect, a form post returns to its page without the action parameter.
  return request.method === "GET" ? url.pathname + url.search : url.pathname;
};

const memberFailure = (cause: AuthenticationFailed | DatabaseUnavailable, next: string): never => {
  if (cause._tag === "DatabaseUnavailable") return pageFailure(cause);

  if (cause.code === "SSO_REQUIRED")
    redirect(
      303,
      `/sign-in?${new URLSearchParams({ organization: cause.organizationSlug ?? "", next })}`,
    );

  // A stale selection can be repaired without signing out of a valid session.
  if (cause.code === "ORGANIZATION_REQUIRED" || cause.code === "FORBIDDEN")
    redirect(303, `/organizations?${new URLSearchParams({ next })}`);

  return pageFailure(cause);
};

// Paths without an organization, such as the start page, open the session's organization:
// the last workspace page opened or, before that, the member's only organization.
export const sessionMember = async () => {
  const { user, session } = getUserSession();
  const runtime = await getRuntime();

  const result = await runtime.identity.member(
    user.id,
    { organizationId: session.activeOrganizationId ?? null },
    session.identityOrganizationId ?? null,
    session.id,
  );

  if (result.isErr()) return memberFailure(result.error, requestDestination());
  session.activeOrganizationId = result.value.organization.id;
  runtime.reporting.active(result.value.principal.id);

  return result.value;
};

// Workspace pages name their organization in the URL. Opening one makes it the session's
// organization, so paths without an organization return to it. Links to another organization
// turn off data preloading, otherwise hovering them would switch it.
// Organizations a person cannot open resolve to null and look the same as missing ones.
const resolvePageMember = async () => {
  const { user, session } = getUserSession();
  const { params } = getRequestEvent();
  const runtime = await getRuntime();
  const slug = params["organization"];

  if (!slug) return null;

  const result = await runtime.identity.member(
    user.id,
    { organizationSlug: slug },
    session.identityOrganizationId ?? null,
  );

  if (result.isErr()) {
    if (result.error._tag === "AuthenticationFailed" && result.error.code === "FORBIDDEN")
      return null;

    return memberFailure(result.error, requestDestination());
  }

  const { organization, principal } = result.value;

  if (session.activeOrganizationId !== organization.id) {
    const remembered = await runtime.identity.rememberOrganization(
      session.id,
      user.id,
      organization.id,
    );

    if (remembered.isErr()) return pageFailure(remembered.error);
    session.activeOrganizationId = organization.id;
  }

  runtime.reporting.active(principal.id);

  return result.value;
};

// The request hook checks workspace pages before any load runs, so sign-in keeps the page as
// its return path. The workspace layout then shows an unavailable organization as not found.
export const authorizeWorkspacePage = async () => {
  const member = await resolvePageMember();

  getRequestEvent().locals.workspace = member && {
    id: member.organization.id,
    slug: member.organization.slug,
  };
};

export const pageMember = async () => {
  const member = await resolvePageMember();

  if (!member) error(404, "Organization not found.");

  return member;
};

export const pagePrincipal = async () => (await pageMember()).principal;

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
    if (cause.statusCode >= 500) runExtensionEffect(() => reportRequestException(cause));
    error(cause.statusCode, cause.message);
  }

  if (cause._tag === "DatabaseUnavailable" || cause._tag === "StorageUnavailable")
    runExtensionEffect(() =>
      reportRequestException(cause.cause instanceof Error ? cause.cause : cause),
    );

  if (cause._tag === "DatabaseUnavailable") error(503, "The database is temporarily unavailable.");

  if (cause._tag === "StorageUnavailable") error(503, "File storage is temporarily unavailable.");
  error(operationStatus[cause.code], cause.message);
};
