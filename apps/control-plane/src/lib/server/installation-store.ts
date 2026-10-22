import { installationSettings, setupOwner } from "@platform/contracts";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { installationOrganizationId } from "../organization.ts";
import { member, user } from "./auth-schema.ts";
import type { Database, DatabaseExecutor } from "./database.ts";
import { InvalidOperation } from "./errors.ts";
import { installation, organizationSettings } from "./schema.ts";

export const installationId = "widefleet";

export const initializeInstallation = async (database: Database) => {
  await database
    .insert(installation)
    .values({
      id: installationId,
    })
    .onConflictDoNothing();
  await database
    .insert(organizationSettings)
    .values({
      organizationId: installationOrganizationId,
      settings: installationSettings.parse({}),
    })
    .onConflictDoNothing();
};

export const readOrganizationSettings = async (
  database: DatabaseExecutor,
  organizationId: string,
) => {
  const [record] = await database
    .select()
    .from(organizationSettings)
    .where(eq(organizationSettings.organizationId, organizationId));

  return installationSettings.parse(record?.settings ?? {});
};

export const readInstallation = async (database: DatabaseExecutor) => {
  const [row] = await database
    .select()
    .from(installation)
    .where(eq(installation.id, installationId));

  if (!row) throw new Error("The installation has not been initialized");

  return {
    ownerId: row.ownerId,
    bootstrapPending: row.bootstrapPending,
  };
};

export const createInstallationOwner = async (
  database: Database,
  input: z.infer<typeof setupOwner>,
  bootstrapPending = false,
) => {
  if ((await readInstallation(database)).ownerId)
    throw new InvalidOperation({
      code: "CONFLICT",
      message: "The first administrator has already been created",
    });

  const owner = setupOwner.parse(input);

  return database.transaction(async (transaction) => {
    const [state] = await transaction
      .select()
      .from(installation)
      .where(eq(installation.id, installationId))
      .for("update");

    if (!state || state.ownerId)
      throw new InvalidOperation({
        code: "CONFLICT",
        message: "The first administrator has already been created",
      });
    const userId = crypto.randomUUID();
    const now = new Date();
    await transaction.insert(user).values({
      id: userId,
      name: owner.name,
      email: owner.email.toLowerCase(),
      emailVerified: false,
      createdAt: now,
      updatedAt: now,
    });
    await transaction.insert(member).values({
      id: crypto.randomUUID(),
      organizationId: installationOrganizationId,
      userId,
      role: "owner",
      createdAt: now,
    });
    await transaction
      .update(installation)
      .set({ ownerId: userId, bootstrapPending })
      .where(eq(installation.id, installationId));

    return { id: userId, name: owner.name, email: owner.email.toLowerCase() };
  });
};
