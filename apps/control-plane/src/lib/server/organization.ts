import { eq } from "drizzle-orm";
import { installationOrganizationId } from "../organization.ts";
import { member, organization } from "./auth-schema.ts";
import type { Database, DatabaseExecutor } from "./database.ts";
import { InvalidOperation } from "./errors.ts";

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

// Links to workspace pages from outside them, such as CLI output or connector returns, need the
// slug that starts the page's address.
export const readOrganizationSlug = async (database: DatabaseExecutor, organizationId: string) => {
  const [current] = await database
    .select({ slug: organization.slug })
    .from(organization)
    .where(eq(organization.id, organizationId));

  if (!current)
    throw new InvalidOperation({ code: "NOT_FOUND", message: "Organization not found" });

  return current.slug;
};

export const enrollCompanyUser = async (database: DatabaseExecutor, userId: string) => {
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
