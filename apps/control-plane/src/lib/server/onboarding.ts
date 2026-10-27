import { eq } from "drizzle-orm";
import { createOrganizationInput, onboardingOrganization } from "@platform/contracts";
import type { z } from "zod";
import type { Database } from "./database.ts";
import type { AuthenticatedUser } from "./identity.ts";
import type { createSettingsService } from "./settings.ts";
import { user } from "./auth-schema.ts";
import { InvalidOperation } from "./errors.ts";

// Provisioning belongs to the installation. Authentication and the browser/API
// flow stay shared; a verified account alone never grants organization access.
export interface OrganizationOnboarding {
  available: (ownerId: string) => Promise<boolean>;
  prepare: (
    ownerId: string,
    input: z.infer<typeof createOrganizationInput>,
  ) => Promise<z.infer<typeof onboardingOrganization>>;
  activate: (organizationId: string, ownerId: string) => Promise<void>;
}

export const createOnboardingService = (
  database: Database,
  settings: Pick<ReturnType<typeof createSettingsService>, "publish">,
  provisioning?: OrganizationOnboarding,
) => {
  const owner = async (person: AuthenticatedUser) => {
    if (person.identityOrganizationId !== null)
      throw new InvalidOperation({
        code: "FORBIDDEN",
        message: "Sign in with an email code to create an organization",
      });
    const [current] = await database.select().from(user).where(eq(user.id, person.userId));

    if (!current?.emailVerified)
      throw new InvalidOperation({ code: "FORBIDDEN", message: "Verify your email first" });

    return current;
  };

  return {
    available: async (person: AuthenticatedUser) => {
      if (!provisioning || person.identityOrganizationId !== null) return false;
      const [current] = await database.select().from(user).where(eq(user.id, person.userId));

      return current?.emailVerified === true && (await provisioning.available(current.id));
    },
    create: async (person: AuthenticatedUser, input: z.infer<typeof createOrganizationInput>) => {
      if (!provisioning)
        throw new InvalidOperation({
          code: "FORBIDDEN",
          message: "Organization creation is disabled",
        });
      const current = await owner(person);

      const organization = onboardingOrganization.parse(
        await provisioning.prepare(current.id, createOrganizationInput.parse(input)),
      );

      // A retry resumes the prepared organization after a publication failure.
      const publication = await settings.publish(organization.id);

      if (publication.error || publication.activation.state !== "active")
        throw new InvalidOperation({
          code: "CONFLICT",
          message: "Your organization is being prepared. Retry to finish setup.",
        });
      await provisioning.activate(organization.id, current.id);

      return organization;
    },
  };
};
