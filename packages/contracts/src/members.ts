import { z } from "zod";
import { organizationChoice } from "./organizations.ts";

export const memberQuery = z.object({
  search: z.string().trim().max(200).default(""),
  page: z.number().int().min(1).max(100_000).default(1),
});

export const memberEntry = z.object({
  id: z.string(),
  userId: z.string(),
  name: z.string(),
  email: z.email(),
  role: organizationChoice.shape.role,
});

export const memberPage = z.object({ members: z.array(memberEntry), hasNext: z.boolean() });

export const companyAccount = z.object({
  organizationId: z.string(),
  provider: z.string().nullable(),
  label: z.string().nullable(),
  linked: z.boolean(),
  tested: z.boolean(),
  accountUrl: z.url(),
});

export const memberRoleInput = z.object({
  memberId: z.string().min(1).max(200),
  role: organizationChoice.shape.role,
});

export const invitationInput = z.object({
  email: z
    .email()
    .max(254)
    .transform((value) => value.toLowerCase()),
  role: organizationChoice.shape.role.default("member"),
});

export const invitationEntry = z.object({
  id: z.string(),
  email: z.email(),
  role: organizationChoice.shape.role,
  status: z.enum(["pending", "accepted", "canceled", "expired"]),
  expiresAt: z.iso.datetime(),
});

export const memberPath = memberRoleInput.pick({ memberId: true });

export const invitationPath = z.object({ invitationId: z.uuid() });

export const invitationDetails = invitationEntry.extend({
  organizationId: z.string(),
  organizationName: z.string(),
});

export const invitationAcceptance = invitationPath;
