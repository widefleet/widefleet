import { APIError } from "better-auth/api";
import type { Authentication } from "./auth.ts";
import { InvalidOperation } from "./errors.ts";

export type OrganizationCredential = { auth: Authentication; headers: Headers };

export const organizationOperation = async <T>(
  credential: OrganizationCredential,
  run: (api: Authentication["api"], headers: Headers) => Promise<T>,
) => {
  try {
    return await run(credential.auth.api, credential.headers);
  } catch (cause) {
    if (cause instanceof APIError)
      throw new InvalidOperation({
        code: [
          "INVITATION_NOT_FOUND",
          "YOU_CANNOT_LEAVE_THE_ORGANIZATION_AS_THE_ONLY_OWNER",
          "YOU_CANNOT_LEAVE_THE_ORGANIZATION_WITHOUT_AN_OWNER",
        ].includes(cause.body?.code ?? "")
          ? "CONFLICT"
          : cause.statusCode === 401 || cause.statusCode === 403
            ? "FORBIDDEN"
            : cause.statusCode === 404
              ? "NOT_FOUND"
              : cause.statusCode === 409
                ? "CONFLICT"
                : "BAD_REQUEST",
        message: cause.message,
      });
    throw cause;
  }
};
