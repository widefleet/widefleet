import { z } from "zod";

export const organizationIdentifier = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9_-]+$/);

export const organizationSelection = z.object({ organizationId: organizationIdentifier });

export const organizationChoice = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
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
