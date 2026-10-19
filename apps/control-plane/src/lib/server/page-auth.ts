import { error, redirect } from "@sveltejs/kit";
import type { DatabaseUnavailable, InvalidOperation, StorageUnavailable } from "./errors.ts";
import { getRuntime } from "./runtime.ts";
import { readInstallation } from "./installation-store.ts";
import { AuthenticationFailed } from "./identity.ts";

export const identityFailure = (
  cause: AuthenticationFailed | DatabaseUnavailable,
  request: Request,
): never => {
  if (cause._tag === "DatabaseUnavailable") error(503, "Sign-in is temporarily unavailable.");

  if (cause.code === "ORGANIZATION_REQUIRED") redirect(303, "/organizations");

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

export const pagePrincipal = async (request: Request, write = false) => {
  const runtime = await getRuntime();

  if (!(await readInstallation(runtime.database.db)).ownerId) redirect(303, "/setup");

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
    redirect(303, "/organizations");
  }

  return identityFailure(result.error, request);
};

const operationStatus = { NOT_FOUND: 404, FORBIDDEN: 403, CONFLICT: 409, BAD_REQUEST: 400 };

export const pageFailure = (
  cause: DatabaseUnavailable | InvalidOperation | StorageUnavailable,
): never => {
  if (cause._tag === "DatabaseUnavailable") error(503, "The database is temporarily unavailable.");

  if (cause._tag === "StorageUnavailable") error(503, "File storage is temporarily unavailable.");
  error(operationStatus[cause.code], cause.message);
};
