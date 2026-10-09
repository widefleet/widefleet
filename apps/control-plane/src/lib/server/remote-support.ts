import { getRequestEvent } from "$app/server";
import { error, invalid } from "@sveltejs/kit";
import type { Result } from "better-result";
import { DatabaseUnavailable, InvalidOperation, StorageUnavailable } from "./errors.ts";
import { pageFailure } from "./page-auth.ts";
import { getRuntime } from "./runtime.ts";

export const remoteContext = async (write = false) => {
  const { request } = getRequestEvent();
  const runtime = await getRuntime();

  const principal = await runtime.identity.authenticate(
    request,
    write ? "platform:write" : "platform:read",
  );

  if (principal.isErr()) {
    if (principal.error instanceof DatabaseUnavailable) return pageFailure(principal.error);
    error(principal.error.code === "UNAUTHORIZED" ? 401 : 403, principal.error.message);
  }

  runtime.reporting.active(principal.value.id);

  return { runtime, principal: principal.value, request };
};

export const queryValue = <T>(
  result: Result<T, InvalidOperation | DatabaseUnavailable | StorageUnavailable>,
) => {
  if (result.isErr()) return pageFailure(result.error);

  return result.value;
};

export const formValue = <T>(
  result: Result<T, InvalidOperation | DatabaseUnavailable | StorageUnavailable>,
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
    throw cause;
  }
};
