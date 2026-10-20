import { z } from "zod";

export const organizationSelection = z.object({ organizationId: z.string().min(1).max(128) });

export const organizationChoice = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  role: z.enum(["owner", "admin", "member"]),
});

export const applicationContext = z.object({
  fleetId: z.uuid(),
  organizationId: z.string().min(1),
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
