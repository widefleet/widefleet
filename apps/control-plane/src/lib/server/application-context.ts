import { z } from "zod";

// This context is resolved from authenticated membership, never accepted as request input.
// Background commands retain it so opening a fresh database cannot widen app access.
export const applicationContext = z.object({
  fleetId: z.uuid(),
  organizationId: z.string().min(1),
  admin: z.boolean(),
});

export type FleetSelector = (input: {
  userId: string;
  request: Request;
  activeOrganizationId: string | null;
}) => Promise<string>;
