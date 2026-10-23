import { and, eq, gt, like, lt } from "drizzle-orm";
import { APIError } from "better-auth/api";
import { z } from "zod";
import { member, organization, verification } from "./auth-schema.ts";
import type { DatabaseExecutor } from "./database.ts";

export const cliContextRequest = z.string().regex(/^[A-Za-z0-9_-]{43}$/);

const prefix = "cli-context:";

const contextValue = z.object({ userId: z.string(), organizationId: z.string() });

export const saveCliContext = async (
  database: DatabaseExecutor,
  request: string,
  userId: string,
  organizationId: string,
) => {
  const id = prefix + cliContextRequest.parse(request);
  const value = JSON.stringify({ userId, organizationId });
  await database
    .delete(verification)
    .where(and(like(verification.id, `${prefix}%`), lt(verification.expiresAt, new Date())));
  await database
    .insert(verification)
    .values({ id, identifier: id, value, expiresAt: new Date(Date.now() + 30 * 60_000) })
    .onConflictDoNothing();

  const [saved] = await database
    .select({ value: verification.value })
    .from(verification)
    .where(eq(verification.id, id));

  if (saved?.value !== value)
    throw new APIError("CONFLICT", {
      message:
        "This request already selected a different account or organization. Restart CLI sign-in.",
    });
};

export const readCliContext = async (
  database: DatabaseExecutor,
  request: string,
  userId: string,
  identityOrganizationId: string | null,
) => {
  const [saved] = await database
    .select({ value: verification.value })
    .from(verification)
    .where(
      and(
        eq(verification.id, prefix + cliContextRequest.parse(request)),
        gt(verification.expiresAt, new Date()),
      ),
    );

  if (!saved)
    throw new APIError("NOT_FOUND", {
      message: "The CLI organization selection is missing or expired. Restart sign-in.",
    });
  const value = contextValue.parse(JSON.parse(saved.value));

  if (
    value.userId !== userId ||
    (identityOrganizationId !== null && value.organizationId !== identityOrganizationId)
  )
    throw new APIError("FORBIDDEN", { message: "This selection belongs to a different sign-in" });

  const [company] = await database
    .select({ name: organization.name })
    .from(organization)
    .innerJoin(member, eq(member.organizationId, organization.id))
    .where(and(eq(organization.id, value.organizationId), eq(member.userId, userId)));

  if (!company)
    throw new APIError("FORBIDDEN", {
      message: "The selected organization is no longer available",
    });

  return { organization_id: value.organizationId, organization_name: company.name };
};
