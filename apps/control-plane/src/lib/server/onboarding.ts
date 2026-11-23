import { and, eq } from "drizzle-orm";
import {
  createOrganizationInput,
  onboardingOrganization,
  organizationCreation,
} from "@platform/contracts";
import type { z } from "zod";
import type { Database } from "./database.ts";
import { companySignInLimit, type SignIn } from "./sso-policy.ts";
import {
  addJoinDomain,
  offeredJoinDomain,
  organizationCreationRestriction,
  provenEmailDomain,
  requireJoinDomain,
  requireOrganizationCreation,
} from "./domain-access.ts";
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
  // Organizations created here belong to the person, so company sign-ins that are limited to
  // their organization cannot create them.
  const verifiedUser = async (person: SignIn) => {
    if ((await companySignInLimit(database, person)) !== null) return false;
    const [current] = await database.select().from(user).where(eq(user.id, person.userId));

    return current?.emailVerified === true;
  };

  return {
    available: async (person: SignIn) => {
      if (
        !createOrganization ||
        !(await verifiedUser(person)) ||
        (await organizationCreationRestriction(database, person.userId)) !== null
      )
        return false;

      const [owned] = await database
        .select({ id: member.id })
        .from(member)
        .where(and(eq(member.userId, person.userId), eq(member.role, "owner")))
        .limit(1);

      return !owned;
    },
    // The domain a new organization can let join, or the domain whose company reserves new
    // organizations for its administrators.
    domains: async (person: SignIn) =>
      createOrganization
        ? {
            joinDomain: await offeredJoinDomain(database, person.userId, null),
            restricted: await organizationCreationRestriction(database, person.userId),
          }
        : { joinDomain: null, restricted: null },
    create: async (person: SignIn, input: z.input<typeof organizationCreation>) => {
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

      const { allowDomainJoin, ...organizationInput } = organizationCreation.parse(input);
      await requireOrganizationCreation(database, person.userId);
      const joinDomain = allowDomainJoin ? await provenEmailDomain(database, person.userId) : null;

      if (allowDomainJoin && !joinDomain)
        throw new InvalidOperation({
          code: "FORBIDDEN",
          message:
            "Sign in with Google Workspace, a Microsoft work account or your company SSO to let your colleagues join.",
        });

      if (joinDomain) await requireJoinDomain(database, person.userId, null, joinDomain);

      const organization = await createOrganization(
        person.userId,
        createOrganizationInput.parse(organizationInput),
      );

      if (joinDomain) await addJoinDomain(database, organization.id, joinDomain);

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
