import { z } from "zod";

export const appCaller = z.strictObject({
  issuer: z.url(),
  subject: z.string().min(1),
  name: z.string(),
});
