import { z } from "zod";
import { appCaller } from "./app-caller.ts";
import { appAccessGroup } from "./app-access.ts";
import { organizationIdentifier } from "./organizations.ts";

export const userConnectionStatus = z.strictObject({
  setup: z.enum(["ready", "required"]),
  connection: z.enum(["connected", "disconnected"]),
  account: z.strictObject({ id: z.string().max(4096), label: z.string().max(4096) }).nullable(),
});

export const userConnectionLaunch = z.strictObject({
  url: z.url(),
  expiresAt: z.iso.datetime(),
});

export const userConnectionAction = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("status") }),
  z.strictObject({ action: z.literal("prepare"), completionUrl: z.url() }),
  z.strictObject({ action: z.literal("disconnect") }),
]);

// Only the authenticated control plane supplies this identity to runtime management.
export const userConnectionInvocation = z.strictObject({
  organizationId: organizationIdentifier,
  appId: z.uuid(),
  hostname: z.string().regex(/^[a-z0-9.-]+$/),
  identityVersion: z.string().min(1),
  identityExpiresAt: z.number().finite().positive(),
  identity: appCaller.extend({ groups: z.array(appAccessGroup) }),
  operation: userConnectionAction,
});

export const userConnectionEntry = z.strictObject({
  appId: z.uuid(),
  displayName: z.string(),
  hostname: z.string(),
  status: userConnectionStatus.nullable(),
  unavailable: z.boolean(),
});

export const userConnectionInput = z.strictObject({ appId: z.uuid() });

export const userConnectionPrepareInput = userConnectionInput.extend({
  onboarding: z.boolean().default(false),
});

export const userConnectionControlPath = "/.well-known/widefleet/user-connections";
