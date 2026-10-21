import { betterAuth } from "better-auth";
import { APIError } from "better-auth/api";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import type { Authentication } from "./auth.ts";
import * as schema from "./auth-schema.ts";
import type { DatabaseExecutor } from "./database.ts";
import { InvalidOperation } from "./errors.ts";

export type OrganizationCredential = { auth: Authentication; headers: Headers };

// Use the caller's actual browser/OAuth credential and the caller's transaction.
// The organization lock held by the service serializes policy checks and writes.
export const organizationOperation = async <T>(
  database: DatabaseExecutor,
  credential: OrganizationCredential,
  run: (api: Authentication["api"], headers: Headers) => Promise<T>,
) => {
  const auth = betterAuth({
    ...credential.auth.options,
    database: drizzleAdapter(database, { provider: "pg", schema, transaction: true }),
  });

  try {
    return await run(auth.api, credential.headers);
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
