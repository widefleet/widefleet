import { and, eq } from "drizzle-orm";
import { createOrganizationInput, onboardingOrganization } from "@platform/contracts";
import type { z } from "zod";
import type { Database } from "./database.ts";
import type { AuthenticatedUser } from "./identity.ts";
import type { createSettingsService } from "./settings.ts";
import { member, user } from "./auth-schema.ts";
import { InvalidOperation } from "./errors.ts";
import { observe, type Observation } from "./observation.ts";

export type CreateOrganization = (
  ownerId: string,
  input: z.infer<typeof createOrganizationInput>,
) => Promise<z.infer<typeof onboardingOrganization>>;

export const createOnboardingService = (
  database: Database,
  settings: Pick<ReturnType<typeof createSettingsService>, "publish">,
  createOrganization?: CreateOrganization,
  observation?: Observation,
) => {
  const verifiedUser = async (person: AuthenticatedUser) => {
    if (person.identityOrganizationId !== null) return false;
    const [current] = await database.select().from(user).where(eq(user.id, person.userId));

    return current?.emailVerified === true;
  };

  return {
    available: async (person: AuthenticatedUser) => {
      if (!createOrganization || !(await verifiedUser(person))) return false;

      const [owned] = await database
        .select({ id: member.id })
        .from(member)
        .where(and(eq(member.userId, person.userId), eq(member.role, "owner")))
        .limit(1);

      return !owned;
    },
    create: async (person: AuthenticatedUser, input: z.infer<typeof createOrganizationInput>) => {
      if (!createOrganization)
        throw new InvalidOperation({
          code: "FORBIDDEN",
          message: "Organization creation is unavailable on this installation",
        });

      if (!(await verifiedUser(person)))
        throw new InvalidOperation({
          code: "FORBIDDEN",
          message: "Sign in with a verified email code to create an organization",
        });

      const organization = await createOrganization(
        person.userId,
        createOrganizationInput.parse(input),
      );

      observe(observation, {
        event: "organization_created",
        id: organization.id,
        userId: person.userId,
        organizationId: organization.id,
        properties: { source: "self_service" },
      });

      const publication = await settings.publish(organization.id);

      if (publication.error || publication.activation.state !== "active")
        throw new InvalidOperation({
          code: "CONFLICT",
          message:
            "Your organization was created, but app sign-in is not ready. Retry or open organization settings.",
        });

      return organization;
    },
  };
};
