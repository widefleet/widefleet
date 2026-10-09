import { z } from "zod";

// OAuth2 Proxy separates group IDs with commas. Never let one ID become several
// alternatives, or disappear when it parses the generated restriction.
export const appAccessGroup = z
  .string()
  .trim()
  .min(1)
  .max(256)
  .refine(
    (value) =>
      !value.includes(",") &&
      Array.from(value).every((character) => {
        const code = character.charCodeAt(0);

        return code >= 32 && code !== 127;
      }),
    "Use a group ID without commas or control characters",
  );

export const appAccessGroups = z
  .array(appAccessGroup)
  .max(100)
  .refine((groups) => new Set(groups).size === groups.length, "Group IDs must be unique");

export const appAccessSnapshot = z.strictObject({
  revision: z.number().int().nonnegative(),
  groups: appAccessGroups,
});

export const appAccessChange = z.strictObject({
  groups: appAccessGroups,
  revision: z.number().int().nonnegative(),
});

export const appAccessStatus = appAccessSnapshot.extend({
  appliedRevision: z.number().int().nonnegative().nullable(),
  state: z.enum(["saved", "pending", "active", "failed"]),
  error: z.string().nullable(),
});

export const appAccessState = appAccessStatus.extend({
  inheritedFrom: z.uuid().nullable(),
  canManage: z.boolean(),
  previews: z.array(appAccessStatus.extend({ appId: z.uuid(), hostname: z.string() })),
});
