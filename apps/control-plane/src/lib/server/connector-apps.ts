import bundle from "@platform/connectors/bundle" with { type: "json" };
import * as contract from "@platform/contracts";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "./database.ts";
import type { Configuration } from "./config.ts";
import type { Principal } from "./identity.ts";
import type { ArtifactStorage } from "./storage.ts";
import type { HostedExecution } from "./deployment-execution.ts";
import type { Observation } from "./observation.ts";
import { member, user } from "./auth-schema.ts";
import { apps, artifacts, deployments, uploadSessions } from "./schema.ts";
import { provisionApp } from "./apps.ts";
import { createUploadService } from "./uploads.ts";
import { operationId } from "./deployment-execution.ts";
import { encryptSecret } from "./secret-encryption.ts";
import { InvalidOperation } from "./errors.ts";

const connectors = z
  .array(
    z.object({
      slug: contract.appSlug,
      displayName: z.string(),
      source: z.string(),
      network: contract.networkPolicy,
      metadata: z.object({
        ...contract.workerMetadata.shape,
        assets: contract.workerMetadata.shape.assets.optional(),
      }),
    }),
  )
  .parse(bundle);

export const createConnectorApps = (
  database: Database,
  configuration: Configuration,
  storage: ArtifactStorage,
  encryptionKey: string,
  execution?: HostedExecution,
  observation?: Observation,
) => {
  const uploads = createUploadService(database, storage, configuration, execution);

  const ensure = async (principal: Principal) => {
    if (!principal.application.admin)
      throw new InvalidOperation({
        code: "FORBIDDEN",
        message: "Organization administrator permission is required",
      });

    const results: {
      appId: string;
      slug: string;
      status: "created" | "existing" | "name_in_use";
    }[] = [];

    for (const template of connectors) {
      const id = operationId(principal.application.organizationId, `connector:${template.slug}`);

      const app = await provisionApp(
        database,
        configuration,
        principal,
        { slug: template.slug, displayName: template.displayName, parentId: null },
        "create",
        observation,
        {
          id,
          networkPolicy: template.network,
          catalogListed: true,
          secrets: {
            AUTH_SECRET: await encryptSecret(
              encryptionKey,
              `${crypto.randomUUID()}${crypto.randomUUID()}`,
            ),
          },
        },
      );

      if (app.isErr()) {
        if (!(app.error instanceof InvalidOperation) || app.error.code !== "CONFLICT")
          throw app.error;
        results.push({ appId: id, slug: template.slug, status: "name_in_use" });
        continue;
      }

      const [record] = await database.select().from(apps).where(eq(apps.id, id));

      const [deployment] = await database
        .select({ id: deployments.id })
        .from(deployments)
        .where(eq(deployments.appId, id))
        .limit(1);

      if (
        !record ||
        record.removedAt ||
        record.state === "deleting" ||
        record.activeDeploymentId ||
        deployment
      ) {
        results.push({ appId: id, slug: template.slug, status: "existing" });
        continue;
      }

      // This first upload has a stable identity, so retrying organization setup
      // reuses its artifact and deployment request instead of creating duplicates.
      const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
      await database
        .insert(uploadSessions)
        .values({ id, appId: id, userId: principal.id, manifest: {}, expiresAt })
        .onConflictDoUpdate({
          target: uploadSessions.id,
          set: { expiresAt, userId: principal.id },
        });

      const [saved] = await database.select().from(artifacts).where(eq(artifacts.id, id));

      const metadata = saved
        ? contract.workerMetadata.parse(saved.metadata)
        : contract.workerMetadata.parse({
            ...template.metadata,
            assets: { upload_session: id, binding: "ASSETS" },
          });

      const source = async () => {
        if (!saved) return new TextEncoder().encode(template.source);

        const module = contract.artifact.shape.modules
          .parse(saved.modules)
          .find((entry) => entry.name === "worker.js");

        if (!module) throw new Error("The initial connector artifact is missing its worker module");

        return (await storage.get(`apps/${id}/modules/${module.sha256}`)).unwrap();
      };

      (
        await uploads.publish(
          principal,
          id,
          metadata,
          [{ name: "worker.js", type: "esm", bytes: await source() }],
          id,
        )
      ).unwrap();
      results.push({ appId: id, slug: template.slug, status: "created" });
    }

    return results;
  };

  const organization = async (ownerId: string, organizationId: string) => {
    const [owner] = await database
      .select({ id: user.id, name: user.name, email: user.email, role: member.role })
      .from(user)
      .innerJoin(member, eq(member.userId, user.id))
      .where(
        and(
          eq(user.id, ownerId),
          eq(member.organizationId, organizationId),
          eq(member.role, "owner"),
        ),
      );

    if (!owner)
      throw new InvalidOperation({
        code: "FORBIDDEN",
        message: "An organization owner is required to initialize connectors",
      });

    return ensure({
      id: owner.id,
      name: owner.name,
      email: owner.email,
      role: "owner",
      admin: false,
      creator: true,
      application: { organizationId, admin: true },
    });
  };

  return { organization };
};
