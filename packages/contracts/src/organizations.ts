import { z } from "zod";

export const organizationIdentifier = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9_-]+$/);

export const organizationSelection = z.object({ organizationId: organizationIdentifier });

export const createOrganizationInput = z.strictObject({
  name: z.string().trim().min(1).max(200),
  slug: z
    .string()
    .trim()
    // Leave room for the guided 12-character app name and its separating hyphen.
    .max(50)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
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
