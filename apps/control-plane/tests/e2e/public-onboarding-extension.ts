import { and, eq } from "drizzle-orm";
import { member, organization, user } from "../../src/lib/server/auth-schema.ts";
import { organizationRuntimes } from "../../src/lib/server/schema.ts";
import type {
  RuntimeExtension,
  RuntimeExtensionContext,
} from "../../src/lib/server/runtime-extension.ts";
import { createRuntimeExtension as emailExtension } from "./onboarding-extension.ts";

// Only the local browser fixture uses this provisioner and captured mailbox.
export const createRuntimeExtension = ({
  database,
}: RuntimeExtensionContext): RuntimeExtension => ({
  sendEmail: emailExtension().sendEmail,
  createOrganization: (ownerId, input) =>
    database.transaction(async (transaction) => {
      await transaction.select().from(user).where(eq(user.id, ownerId)).for("update");

      const [existing] = await transaction
        .select({ id: organization.id, name: organization.name, slug: organization.slug })
        .from(member)
        .innerJoin(organization, eq(member.organizationId, organization.id))
        .where(and(eq(member.userId, ownerId), eq(member.role, "owner")));

      if (existing) return existing;
      const id = crypto.randomUUID();
      await transaction.insert(organization).values({ id, ...input, createdAt: new Date() });
      await transaction.insert(member).values({
        id: crypto.randomUUID(),
        organizationId: id,
        userId: ownerId,
        role: "owner",
        createdAt: new Date(),
      });
      await transaction
        .insert(organizationRuntimes)
        .values({ organizationId: id, appHostnameSuffix: input.slug });

      return { id, ...input };
    }),
});
