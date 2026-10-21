import { z } from "zod";

export const companyAccount = z.object({
  organizationId: z.string(),
  provider: z.string().nullable(),
  label: z.string().nullable(),
  linked: z.boolean(),
  tested: z.boolean(),
  accountUrl: z.url(),
});
