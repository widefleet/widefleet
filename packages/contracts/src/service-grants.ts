import { z } from "zod";
import { appAccessGroups } from "./app-access.ts";

// Service identities are independent of management roles and browser app access.
export const serviceUser = z.strictObject({
  issuer: z.url(),
  subject: z.string().min(1).max(512),
});

export const serviceGrant = z.strictObject({
  entrypoint: z
    .string()
    .regex(/^[A-Za-z_$][A-Za-z0-9_$]*$/)
    .max(128),
  users: z
    .array(serviceUser)
    .max(100, "An entrypoint can have at most 100 users")
    .refine(
      (users) =>
        new Set(users.map((user) => JSON.stringify([user.issuer, user.subject]))).size ===
        users.length,
      "User identities must be unique",
    ),
  groups: appAccessGroups,
});

export const serviceGrants = z
  .array(serviceGrant)
  .max(32)
  .refine(
    (grants) => new Set(grants.map((grant) => grant.entrypoint)).size === grants.length,
    "Each entrypoint must have one access rule",
  );

export const serviceUserAccess = z.strictObject({
  mode: z.enum(["approval_required", "organization"]),
  grants: serviceGrants,
});

export const serviceGrantsChange = z.strictObject({
  revision: z.number().int().nonnegative(),
  grants: serviceGrants,
});

export const serviceAccessSnapshot = serviceUserAccess.extend({
  revision: z.number().int().nonnegative(),
});

export const serviceAccessUpdate = z
  .strictObject({
    mode: serviceUserAccess.shape.mode.optional(),
    grants: serviceGrants.optional(),
    revision: z.number().int().nonnegative().optional(),
  })
  .refine(
    (input) => input.mode !== undefined || input.grants !== undefined,
    "No access change supplied",
  );

export const serviceGrantsState = serviceAccessSnapshot.extend({
  appliedRevision: z.number().int().nonnegative().nullable(),
  state: z.enum(["saved", "pending", "active", "failed"]),
  error: z.string().nullable(),
});
