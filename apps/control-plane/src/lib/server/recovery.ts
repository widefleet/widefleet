import { makeSignature } from "better-auth/crypto";
import { and, eq, inArray } from "drizzle-orm";
import { installationOrganizationId } from "../organization.ts";
import type { Authentication } from "./auth.ts";
import type { Configuration } from "./config.ts";
import type { Database } from "./database.ts";
import { member, user } from "./auth-schema.ts";

export const createRecoveryLink = async (
  auth: Authentication,
  database: Database,
  configuration: Configuration,
  email: string,
) => {
  const [owner] = await database
    .select({ id: user.id })
    .from(user)
    .innerJoin(member, eq(member.userId, user.id))
    .where(
      and(
        eq(user.email, email.toLowerCase()),
        eq(member.organizationId, installationOrganizationId),
        inArray(member.role, ["owner", "admin"]),
      ),
    );

  if (!owner) throw new Error("An existing platform administrator email is required");
  const context = await auth.$context;

  const session = await context.internalAdapter.createSession(
    owner.id,
    true,
    {
      recovery: true,
      expiresAt: new Date(Date.now() + 10 * 60 * 1000),
    },
    true,
  );

  if (!session) throw new Error("The recovery session could not be created");
  const signature = await makeSignature(session.token, context.secret);

  const headers = new Headers({
    cookie: `${context.authCookies.sessionToken.name}=${encodeURIComponent(`${session.token}.${signature}`)}`,
  });

  const { token } = await auth.api.generateOneTimeToken({ headers });

  return `${configuration.PLATFORM_URL}/recover#token=${encodeURIComponent(token)}`;
};
