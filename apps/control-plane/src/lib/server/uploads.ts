import * as contract from "@platform/contracts";
import { Result } from "better-result";
import { and, eq, gt, sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { checkCapabilityNames } from "./connectors.ts";
import { appUrl, enqueueDeployment, managedApp } from "./apps.ts";
import { hashAsset } from "./asset-hash.ts";
import type { Configuration } from "./config.ts";
import type { Database } from "./database.ts";
import { InvalidOperation } from "./errors.ts";
import type { Principal } from "./identity.ts";
import { artifacts, deployments, uploadSessions } from "./schema.ts";
import type { ArtifactStorage } from "./storage.ts";
import { transact, type Transaction } from "./transactions.ts";

const sourceMapFile = z.object({
  version: z.literal(3),
  sources: z.array(z.string()).max(100_000),
  names: z.array(z.string()),
  mappings: z.string(),
});

export type WorkerModule = {
  name: string;
  type: z.infer<typeof contract.storedModule>["type"];
  bytes: Uint8Array;
};

const getSession = async (
  transaction: Transaction,
  principal: Principal,
  appId: string,
  sessionId: string,
) => {
  const [session] = await transaction
    .select()
    .from(uploadSessions)
    .where(
      and(
        eq(uploadSessions.id, sessionId),
        eq(uploadSessions.appId, appId),
        eq(uploadSessions.userId, principal.id),
        gt(uploadSessions.expiresAt, new Date()),
      ),
    );

  if (!session)
    return Result.err(
      new InvalidOperation({ code: "NOT_FOUND", message: "Upload session not found or expired" }),
    );

  return Result.ok({ ...session, manifest: contract.assetManifest.parse(session.manifest) });
};

export const createUploadService = (
  database: Database,
  storage: ArtifactStorage,
  configuration: Configuration,
) => ({
  start: (principal: Principal, appId: string, manifest: z.infer<typeof contract.assetManifest>) =>
    transact(database, (transaction) =>
      Result.gen(async function* () {
        const record = yield* Result.await(managedApp(transaction, principal, appId, "deploy"));

        if (record.state === "deleting")
          return yield* new InvalidOperation({ code: "CONFLICT", message: "App is being deleted" });

        const inventory = yield* Result.await(storage.assetInventory(appId));
        const missing = new Set<string>();

        for (const entry of Object.values(manifest)) {
          if (inventory.get(entry.hash) !== entry.size) missing.add(entry.hash);
        }

        const id = crypto.randomUUID();
        const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
        await transaction
          .insert(uploadSessions)
          .values({ id, appId, userId: principal.id, manifest, expiresAt });

        return Result.ok({
          id,
          expiresAt: expiresAt.toISOString(),
          missing: [...missing],
          url: appUrl(record.hostname, configuration.APP_HTTPS_PORT),
        });
      }),
    ),
  putAsset: (
    principal: Principal,
    appId: string,
    sessionId: string,
    hash: string,
    bytes: Uint8Array,
  ) =>
    transact(database, (transaction) =>
      Result.gen(async function* () {
        const record = yield* Result.await(managedApp(transaction, principal, appId, "deploy"));

        if (record.state === "deleting")
          return yield* new InvalidOperation({ code: "CONFLICT", message: "App is being deleted" });

        const session = yield* Result.await(getSession(transaction, principal, appId, sessionId));

        const references = Object.entries(session.manifest).filter(
          ([, entry]) => entry.hash === hash,
        );

        if (references.length === 0)
          return yield* new InvalidOperation({
            code: "BAD_REQUEST",
            message: "Asset is not part of this upload manifest",
          });

        for (const [path, entry] of references) {
          if (entry.size !== bytes.byteLength || hashAsset(path, bytes) !== hash) {
            return yield* new InvalidOperation({
              code: "BAD_REQUEST",
              message: "Asset bytes do not match the manifest hash and size",
            });
          }
        }

        yield* Result.await(
          storage.put(`apps/${appId}/assets/${hash}`, bytes, "application/octet-stream"),
        );

        return Result.ok({ uploaded: true });
      }),
    ),
  publish: (
    principal: Principal,
    appId: string,
    metadata: z.infer<typeof contract.workerMetadata>,
    modules: WorkerModule[],
    requestId: string,
  ) =>
    transact(database, (transaction) =>
      Result.gen(async function* () {
        const record = yield* Result.await(managedApp(transaction, principal, appId, "deploy"));

        if (record.state === "deleting")
          return yield* new InvalidOperation({ code: "CONFLICT", message: "App is being deleted" });
        checkCapabilityNames(metadata, contract.capabilityGrants.parse(record.capabilities));

        const session = yield* Result.await(
          getSession(transaction, principal, appId, metadata.assets.upload_session),
        );

        const inventory = yield* Result.await(storage.assetInventory(appId));

        for (const entry of Object.values(session.manifest)) {
          if (inventory.get(entry.hash) !== entry.size)
            return yield* new InvalidOperation({
              code: "CONFLICT",
              message: "Upload all missing assets before publishing the worker",
            });
        }

        if (
          !modules.some((module) => module.name === metadata.main_module && module.type === "esm")
        ) {
          return yield* new InvalidOperation({
            code: "BAD_REQUEST",
            message: "The main ES module is missing",
          });
        }

        if (new Set(modules.map((module) => module.name)).size !== modules.length) {
          return yield* new InvalidOperation({
            code: "BAD_REQUEST",
            message: "Duplicate worker module names",
          });
        }

        const sourceMaps = new Set(Object.values(metadata.debug?.source_maps ?? {}));

        if (
          sourceMaps.size !== modules.filter((module) => module.type === "sourcemap").length ||
          [...sourceMaps].some(
            (name) =>
              !modules.some((module) => module.name === name && module.type === "sourcemap"),
          )
        ) {
          return yield* new InvalidOperation({
            code: "BAD_REQUEST",
            message: "Source-map metadata does not match the uploaded maps",
          });
        }

        for (const module of modules) {
          if (module.type !== "sourcemap") continue;

          const parsed = Result.try(() =>
            sourceMapFile.parse(JSON.parse(new TextDecoder().decode(module.bytes))),
          );

          if (parsed.isErr())
            return yield* new InvalidOperation({
              code: "BAD_REQUEST",
              message: "Invalid source-map JSON",
            });
        }

        const storedModules = contract.artifact.shape.modules
          .parse(
            modules.map((module) => ({
              name: module.name,
              type: module.type,
              size: module.bytes.byteLength,
              sha256: createHash("sha256").update(module.bytes).digest("hex"),
            })),
          )
          .sort((left, right) => left.name.localeCompare(right.name));

        const artifactId = session.id;

        if (metadata.debug) {
          // managedApp holds this app's row lock until commit, serializing the
          // build identity check and artifact insertion across concurrent publishes.
          const [sameBuild] = await transaction
            .select({ modules: artifacts.modules, metadata: artifacts.metadata })
            .from(artifacts)
            .where(
              and(
                eq(artifacts.appId, appId),
                sql`${artifacts.metadata}->'debug'->>'build_id' = ${metadata.debug.build_id}`,
              ),
            )
            .limit(1);

          if (
            sameBuild &&
            (!isDeepStrictEqual(sameBuild.modules, storedModules) ||
              !isDeepStrictEqual(
                contract.workerMetadata.parse(sameBuild.metadata).debug,
                metadata.debug,
              ))
          )
            return yield* new InvalidOperation({
              code: "CONFLICT",
              message:
                "This build version already refers to different code or source maps; rebuild with a new version",
            });
        }

        const [request] = await transaction
          .select({ artifactId: deployments.artifactId })
          .from(deployments)
          .where(and(eq(deployments.appId, appId), eq(deployments.requestId, requestId)));

        if (request && request.artifactId !== artifactId)
          return yield* new InvalidOperation({
            code: "CONFLICT",
            message: "The request ID already refers to another artifact",
          });

        const [existing] = await transaction
          .select()
          .from(artifacts)
          .where(eq(artifacts.id, artifactId));

        if (existing) {
          if (
            !isDeepStrictEqual(existing.metadata, metadata) ||
            !isDeepStrictEqual(existing.modules, storedModules)
          ) {
            return yield* new InvalidOperation({
              code: "CONFLICT",
              message: "This upload session already contains a different worker",
            });
          }

          return enqueueDeployment(transaction, record, artifactId, requestId);
        }

        for (const module of modules) {
          const checksum = createHash("sha256").update(module.bytes).digest("hex");
          yield* Result.await(
            storage.put(
              `apps/${appId}/modules/${checksum}`,
              module.bytes,
              "application/octet-stream",
            ),
          );
        }

        await transaction.insert(artifacts).values({
          id: artifactId,
          appId,
          metadata,
          manifest: session.manifest,
          modules: storedModules,
        });

        return enqueueDeployment(transaction, record, artifactId, requestId);
      }),
    ),
});
