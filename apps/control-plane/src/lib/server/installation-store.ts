import { bootstrapConfiguration, installationSettings, setupOwner } from "@platform/contracts";
import { hashPassword } from "better-auth/crypto";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { installationOrganizationId } from "../organization.ts";
import { account, member, user } from "./auth-schema.ts";
import type { Configuration } from "./config.ts";
import type { Database, DatabaseExecutor } from "./database.ts";
import { InvalidOperation } from "./errors.ts";
import { readOptionalFile } from "./installation-files.ts";
import { installation } from "./schema.ts";

export const installationId = "widefleet";

export const initializeInstallation = async (database: Database) => {
  await database
    .insert(installation)
    .values({
      id: installationId,
      settings: installationSettings.parse({}),
    })
    .onConflictDoNothing();
};

export const readInstallation = async (database: DatabaseExecutor) => {
  const [row] = await database
    .select()
    .from(installation)
    .where(eq(installation.id, installationId));

  if (!row) throw new Error("The installation has not been initialized");

  return {
    settings: installationSettings.parse(row.settings),
    ownerId: row.ownerId,
    localPasswordEnabled: row.localPasswordEnabled,
  };
};

export const createInstallationOwner = async (
  database: Database,
  input: z.infer<typeof setupOwner>,
) => {
  if ((await readInstallation(database)).ownerId)
    throw new InvalidOperation({
      code: "CONFLICT",
      message: "The first administrator has already been created",
    });

  const owner = setupOwner.parse(input);
  const password = await hashPassword(owner.password);

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
    // Use Better Auth's credential account and password hashing; sign-in and sessions stay in Better Auth.
    await transaction.insert(user).values({
      id: userId,
      name: owner.name,
      email: owner.email.toLowerCase(),
      emailVerified: false,
      createdAt: now,
      updatedAt: now,
    });
    await transaction.insert(account).values({
      id: crypto.randomUUID(),
      accountId: userId,
      providerId: "credential",
      userId,
      password,
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
      .set({ ownerId: userId })
      .where(eq(installation.id, installationId));

    return { id: userId, name: owner.name, email: owner.email.toLowerCase() };
  });
};

export const readBootstrap = async (configuration: Configuration) => {
  if (!configuration.PLATFORM_BOOTSTRAP_FILE) return null;
  const source = await readOptionalFile(configuration.PLATFORM_BOOTSTRAP_FILE);

  if (source === null) throw new Error("The configured bootstrap file could not be read");

  return bootstrapConfiguration.parse(JSON.parse(source));
};
