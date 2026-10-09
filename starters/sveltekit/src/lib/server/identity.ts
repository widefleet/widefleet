import { Result, TaggedError } from "better-result";
import { z } from "zod";

const accessContext = z.strictObject({
  id: z.string().min(1),
  name: z.string(),
  email: z.string().nullable(),
  groups: z.array(z.string()),
});

export type AppUser = z.infer<typeof accessContext>;

export class InvalidIdentity extends TaggedError("InvalidIdentity")<{ message: string }> {}

// These headers are trustworthy only on the app's private, authenticated ingress.
// The platform proxy removes client-supplied identity headers before SSO verification.
export const userFromHeaders = (headers: Headers) => {
  const identity = accessContext.safeParse({
    id: headers.get("x-auth-request-user"),
    name: headers.get("x-auth-request-preferred-username") ?? "",
    email: headers.get("x-auth-request-email"),
    groups: (headers.get("x-auth-request-groups") ?? "")
      .split(",")
      .flatMap((group) => (group.trim() ? [group.trim()] : [])),
  });

  return identity.success
    ? Result.ok(identity.data)
    : Result.err(new InvalidIdentity({ message: "A verified platform identity is required" }));
};
