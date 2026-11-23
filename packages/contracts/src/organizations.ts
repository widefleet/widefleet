import { z } from "zod";
import { companyDomain, maxCompanyDomains } from "./settings.ts";

export const organizationIdentifier = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9_-]+$/);

export const organizationSelection = z.object({ organizationId: organizationIdentifier });

// Control-plane pages start with the organization slug, so a slug cannot name a top-level page.
export const reservedOrganizationSlugs = [
  "api",
  "cli-login",
  "device",
  "healthz",
  "invitations",
  "mcp",
  "organizations",
  "recover",
  "setup",
  "sign-in",
  "sign-up",
  "welcome",
] as const;

export const organizationSlugFormat = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

// Any slug an existing organization can have, including those an operator assigned.
export const organizationSlug = z.string().max(63).regex(organizationSlugFormat);

export const createOrganizationInput = z.strictObject({
  name: z.string().trim().min(1).max(200),
  slug: z
    .string()
    .trim()
    // Leave room for the guided 12-character app name and its separating hyphen.
    .max(50)
    .regex(organizationSlugFormat)
    .refine(
      (slug) => !reservedOrganizationSlugs.some((reserved) => reserved === slug),
      "This name is reserved for a Widefleet page",
    ),
});

// Creation can also let everyone at the creator's proven company email domain join.
export const organizationCreation = createOrganizationInput.extend({
  allowDomainJoin: z.boolean().default(false),
});

// Email domains whose verified addresses can join an organization without an invitation.
export const joinDomains = z
  .array(companyDomain)
  .max(maxCompanyDomains)
  .refine((domains) => new Set(domains).size === domains.length, "Enter each domain once");

export const joinDomainInput = z.strictObject({ domain: companyDomain });

export const domainAccess = z.strictObject({
  joinDomains,
  // The domains the current administrator's own sign-in proves, which they can add.
  provableDomains: z.array(z.string()),
  // Domains the organization verified by DNS for company SSO.
  verifiedDomains: z.array(z.string()),
  restrictOrganizationCreation: z.boolean(),
});

export const organizationCreationRestriction = z.strictObject({ restricted: z.boolean() });

export const joinableOrganization = z.object({
  id: organizationIdentifier,
  name: z.string(),
  slug: z.string(),
  domain: z.string(),
  memberCount: z.number().int().nonnegative(),
  // Up to three members with an address on the same domain.
  colleagues: z.array(z.string()).max(3),
  // The organization verified this domain by DNS for company SSO.
  verified: z.boolean(),
});

export const onboardingOrganization = z.object({
  id: organizationIdentifier,
  name: z.string(),
  slug: z.string(),
});

export const organizationChoice = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  ssoRequired: z.boolean().default(false),
  role: z.enum(["owner", "admin", "member"]),
});

export const applicationContext = z.strictObject({
  organizationId: organizationIdentifier,
  admin: z.boolean(),
});

export const currentUser = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string(),
  role: organizationChoice.shape.role,
  admin: z.boolean(),
  creator: z.boolean(),
  application: applicationContext,
});
