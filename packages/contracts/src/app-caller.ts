import { z } from "zod";

export const appCaller = z.strictObject({
  issuer: z.url(),
  subject: z.string().min(1),
  name: z.string(),
});

// Product analytics names an app user by their sign-in identity. The control plane
// derives the same ID for its members to link their app use to their account.
export const appUserDistinctId = async (
  caller: Pick<z.infer<typeof appCaller>, "issuer" | "subject">,
) =>
  `app-user:${Array.from(
    new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(JSON.stringify([caller.issuer, caller.subject])),
      ),
    ),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("")}`;
