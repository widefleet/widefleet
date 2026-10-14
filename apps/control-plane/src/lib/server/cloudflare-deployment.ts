import type { CloudflareWorkersModule } from "@cloudflare/workers-types";
import * as contract from "@platform/contracts";
import { Result } from "better-result";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { createArtifactStorage } from "./artifact-storage.ts";
import { readCloudflareConfiguration, type CloudflareBindings } from "./cloudflare-config.ts";
import { createCloudflareJobService } from "./cloudflare-jobs.ts";
import { CloudflareApiError, createCloudflareProvisioner } from "./cloudflare-provisioning.ts";
import { createDatabase } from "./database.ts";
import { InvalidOperation } from "./errors.ts";
import { completeJob, ownedJob } from "./job-completion.ts";
import { jobs } from "./schema.ts";
import { createR2Storage } from "./storage/r2.ts";
import { transact } from "./transactions.ts";

const deploymentConfiguration = z.object({
  CLOUDFLARE_ACCOUNT_ID: z.string().regex(/^[a-f0-9]{32}$/),
  CLOUDFLARE_API_TOKEN: z.string().min(1),
  APP_RUNTIME_NAME: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/),
  APP_RUNTIME_TOKEN: z.string().min(32),
});

// Keep the immutable access reference with the host record so rules and code switch atomically.
// The groups themselves can exceed R2's metadata limit and live in a separate immutable object.
const accessMetadata = (appId: string, version: string) => ({
  widefleet_access: `access/${appId}/${version}.json`,
});

const withDatabase = async <T>(
  bindings: CloudflareBindings,
  operation: (database: ReturnType<typeof createDatabase>) => Promise<T>,
) => {
  const database = createDatabase(readCloudflareConfiguration(bindings), 1);
  const disconnected: Promise<void>[] = [];
  // Pool.end() resolves before idle clients finish closing their sockets. A Workflow step
  // must release those connections before retries consume more of Workers' connection slots.
  database.db.$client.on("connect", (client) => {
    disconnected.push(new Promise<void>((resolve) => client.once("end", resolve)));
  });

  try {
    return await operation(database);
  } finally {
    await database.close();
    await Promise.all(disconnected);
  }
};

const value = <T, E>(result: Result<T, E>) => {
  if (result.isErr()) throw result.error;

  return result.value;
};

export const createCloudflareDeployment = (bindings: CloudflareBindings, transport = fetch) => {
  const configuration = deploymentConfiguration.parse(bindings);
  const runtime = bindings.APP_RUNTIME;

  if (!runtime) throw new Error("The app runtime service binding is missing");

  const storage = createArtifactStorage(createR2Storage(bindings.ARTIFACTS));

  const provisioner = createCloudflareProvisioner(
    {
      accountId: configuration.CLOUDFLARE_ACCOUNT_ID,
      token: configuration.CLOUDFLARE_API_TOKEN,
      runtimeName: configuration.APP_RUNTIME_NAME,
    },
    transport,
  );

  const readDeployment = (id: string) =>
    withDatabase(bindings, async (database) =>
      value(await createCloudflareJobService(database.db, storage).deployment(id)),
    );

  const deployment = async (id: string) => {
    const input = await readDeployment(id);

    if (!input) throw new Error("This configuration has no active deployment");

    return input;
  };

  const state = (id: string) =>
    withDatabase(bindings, async (database) => {
      const [job] = await database.db
        .select({ state: jobs.state, activation: jobs.activationStartedAt })
        .from(jobs)
        .where(and(eq(jobs.id, id), eq(jobs.workflowId, id)));

      return job;
    });

  const stage = async (id: string, nativeBindings: Record<string, string>) => {
    const input = await deployment(id);

    const app = contract.publishedApp.parse({
      id: input.id,
      appId: input.appId,
      metadata: input.metadata,
      manifest: input.manifest,
      modules: input.modules,
      hostname: input.hostname,
      version: input.version,
      deploymentId: input.deploymentId,
      network: input.network,
      capabilityRevision: input.capabilityRevision,
      nativeBindings,
    });

    const key = `versions/${app.appId}/${app.version}.json`;
    const body = JSON.stringify(app);
    const customMetadata = accessMetadata(app.appId, app.version);
    const accessBody = JSON.stringify(input.access);

    const accessWritten = await bindings.ARTIFACTS.put(
      customMetadata.widefleet_access,
      accessBody,
      {
        onlyIf: { etagDoesNotMatch: "*" },
        httpMetadata: { contentType: "application/json" },
      },
    );

    if (!accessWritten) {
      const existing = await bindings.ARTIFACTS.get(customMetadata.widefleet_access);

      if (!existing || (await existing.text()) !== accessBody)
        throw new Error("The immutable access snapshot already contains different data");
    }

    const written = await bindings.ARTIFACTS.put(key, body, {
      onlyIf: { etagDoesNotMatch: "*" },
      httpMetadata: { contentType: "application/json" },
      customMetadata,
    });

    if (!written) {
      const existing = await bindings.ARTIFACTS.get(key);

      if (
        !existing ||
        (await existing.text()) !== body ||
        existing.customMetadata?.["widefleet_access"] !== customMetadata.widefleet_access
      )
        throw new Error("The immutable deployment version already contains different data");
    }
  };

  const verify = async (id: string) => {
    const app = await deployment(id);

    const response = await runtime.fetch(`https://${app.hostname}/.well-known/widefleet/ready`, {
      headers: {
        authorization: `Bearer ${configuration.APP_RUNTIME_TOKEN}`,
        "x-widefleet-candidate": `${app.appId}/${id}`,
      },
      redirect: "manual",
    });

    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`App readiness check failed (HTTP ${response.status})`);
    }

    z.object({
      deploymentId: z.literal(app.deploymentId),
      version: z.literal(id),
      networkRevision: z.literal(app.network.revision),
      capabilityRevision: z.literal(app.capabilityRevision),
      runtimeVersion: z.literal(app.runtime.version),
    }).parse(await response.json());
  };

  const beginActivation = (id: string) =>
    withDatabase(bindings, async (database) =>
      value(
        await transact(database.db, async (transaction) => {
          const job = await ownedJob(transaction, id, { workflowId: id });

          if (job.isErr()) return job;

          await transaction
            .update(jobs)
            .set({ activationStartedAt: new Date() })
            .where(eq(jobs.id, id));

          return Result.ok(true);
        }),
      ),
    );

  const activate = async (id: string) => {
    const current = await state(id);

    if (!current || current.state !== "running") return;

    if (!current.activation) throw new Error("Deployment has not passed its readiness check");

    const input = await deployment(id);
    const candidate = await bindings.ARTIFACTS.get(`versions/${input.appId}/${id}.json`);

    if (!candidate) throw new Error("The prepared deployment version is missing");

    const body = await candidate.text();
    const app = contract.publishedApp.parse(JSON.parse(body));
    const access = accessMetadata(input.appId, id);

    if (
      app.version !== id ||
      app.hostname !== input.hostname ||
      app.deploymentId !== input.deploymentId ||
      candidate.customMetadata?.["widefleet_access"] !== access.widefleet_access
    )
      throw new Error("The prepared deployment does not match the job");

    await withDatabase(bindings, async (database) =>
      value(
        await completeJob(
          database.db,
          storage,
          { workflowId: id },
          id,
          {
            outcome: "succeeded",
            message: "Cloudflare activated the deployment",
            accessRevision: input.access.revision,
          },
          undefined,
          async () => {
            const key = `hosts/${app.hostname}.json`;
            const current = await bindings.ARTIFACTS.get(key);

            if (
              current &&
              (await current.text()) === body &&
              current.customMetadata?.["widefleet_access"] === access.widefleet_access
            )
              return;

            // A timed-out older PUT must not overwrite a later activation if it arrives late.
            const activated = await bindings.ARTIFACTS.put(key, body, {
              onlyIf: current ? { etagMatches: current.etag } : { etagDoesNotMatch: "*" },
              httpMetadata: { contentType: "application/json" },
              customMetadata: access,
            });

            if (!activated) throw new Error("The active version changed during activation");
          },
        ),
      ),
    );
  };

  const fail = async (id: string, message: string) => {
    const current = await state(id);

    if (!current || current.state !== "running") return;

    // Once activation starts, a lost R2/SQL response must be reconciled, never marked failed.
    if (current.activation) throw new Error("Deployment activation must be reconciled");

    await withDatabase(bindings, async (database) =>
      value(
        await completeJob(database.db, storage, { workflowId: id }, id, {
          outcome: "failed",
          message,
        }),
      ),
    );
  };

  return {
    state,
    hasDeployment: async (id: string) => (await readDeployment(id)) !== null,
    completeConfiguration: (id: string) =>
      withDatabase(bindings, async (database) =>
        value(
          await completeJob(database.db, storage, { workflowId: id }, id, {
            outcome: "succeeded",
            message: "Configuration saved for the first deployment",
          }),
        ),
      ),
    provision: async (id: string) => provisioner.provision(await deployment(id)),
    stage,
    verify,
    beginActivation,
    activate,
    fail,
  };
};

export const dispatchCloudflareDeployment = async (bindings: CloudflareBindings) => {
  const workflow = bindings.DEPLOYMENTS;

  if (!workflow) return;

  const job = await withDatabase(bindings, async (database) => {
    const storage = createArtifactStorage(createR2Storage(bindings.ARTIFACTS));

    return value(await createCloudflareJobService(database.db, storage).next());
  });

  if (!job) return;

  try {
    await workflow.create({ id: job.id, params: { jobId: job.id } });
  } catch (error) {
    // Creation may have succeeded before its response was lost, or another request dispatched it.
    const instance = await workflow.get(job.id);
    const status = await instance.status();

    if (status.status === "errored") await instance.restart();
    else if (status.status === "unknown") throw error;
  }
};

export const executeCloudflareDeployment = async (
  bindings: CloudflareBindings,
  id: string,
  step: CloudflareWorkersModule.WorkflowStep,
  transport = fetch,
) => {
  const runner = createCloudflareDeployment(bindings, transport);

  const options = {
    retries: { limit: 5, delay: "2 seconds", backoff: "exponential" },
    timeout: "2 minutes",
  } as const;

  const initial = await step.do("execution-state", options, () => runner.state(id));

  if (!initial || initial.state !== "running") return;

  if (!initial.activation) {
    try {
      const validation = await step.do("validate-deployment", options, async () => {
        try {
          return { error: null, hasDeployment: await runner.hasDeployment(id) };
        } catch (error) {
          if (error instanceof InvalidOperation)
            return { error: error.message, hasDeployment: false };
          throw error;
        }
      });

      if (validation.error) {
        await step.do("reject-deployment", options, () =>
          runner.fail(id, validation.error ?? "Invalid deployment"),
        );

        return;
      }

      if (!validation.hasDeployment) {
        await step.do("save-configuration", options, () => runner.completeConfiguration(id));

        return;
      }

      const nativeBindings = await step.do("provision-resources", options, () =>
        runner.provision(id),
      );

      await step.do("stage-version", options, () => runner.stage(id, nativeBindings));
      await step.do("verify-version", options, () => runner.verify(id));
      await step.do("begin-activation", options, () => runner.beginActivation(id));
    } catch (error) {
      const message =
        error instanceof InvalidOperation || error instanceof CloudflareApiError
          ? error.message
          : "Cloudflare could not prepare the deployment";

      await step.do("record-failure", options, () => runner.fail(id, message));

      return;
    }
  }

  await step.do("activate-version", options, () => runner.activate(id));
};
