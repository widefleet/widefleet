import { eq } from "drizzle-orm";
import { installationOrganizationId } from "../organization.ts";
import { member, organization } from "./auth-schema.ts";
import type { Database } from "./database.ts";

export const initializeOrganization = async (database: Database) => {
  await database
    .insert(organization)
    .values({
      id: installationOrganizationId,
      name: "Widefleet",
      slug: "widefleet",
      createdAt: new Date(),
    })
    .onConflictDoNothing();
};

export const enrollCompanyUser = async (database: Database, userId: string) => {
  const [installation] = await database
    .select({ id: organization.id })
    .from(organization)
    .where(eq(organization.id, installationOrganizationId));

  if (!installation) throw new Error("Initialize the installation before accepting sign-ins");
  await database
    .insert(member)
    .values({
      id: crypto.randomUUID(),
      organizationId: installationOrganizationId,
      userId,
      role: "member",
      createdAt: new Date(),
    })
    .onConflictDoNothing();
};
