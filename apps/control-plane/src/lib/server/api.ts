import { OpenAPIHandler } from "@orpc/openapi/fetch";
import { OpenAPIGenerator } from "@orpc/openapi";
import { ORPCError, os } from "@orpc/server";
import { ZodToJsonSchemaConverter } from "@orpc/zod/zod4";
import * as contract from "@platform/contracts";
import type { Result } from "better-result";
import { z } from "zod";
import type { Runtime } from "./runtime.ts";
import { parseWorkerUpload, readBody } from "./upload-body.ts";
import { binaryPaths, binarySchemas } from "./openapi-binary.ts";
import { DirectoryUnavailable } from "./directory.ts";
import { InvalidOperation, TelemetryNotConfigured, TelemetryUnavailable } from "./errors.ts";
import { createInstallationOwner, readInstallation } from "./installation-store.ts";

const settingsOperation = async <T>(operation: () => Promise<T>) => {
  try {
    return await operation();
  } catch (cause) {
    if (cause instanceof InvalidOperation)
      throw new ORPCError(cause.code, { message: cause.message });
    throw cause;
  }
};

const unwrap = <T, E extends { message: string }>(result: Result<T, E>) => {
  if (result.isOk()) return result.value;
  const error = result.error;

  if (error instanceof DirectoryUnavailable)
    throw new ORPCError("SERVICE_UNAVAILABLE", { message: error.message });

  if (error instanceof TelemetryNotConfigured)
    throw new ORPCError("TELEMETRY_NOT_CONFIGURED", { status: 503, message: error.message });

  if ("code" in error) {
    const code = z
      .enum(["UNAUTHORIZED", "FORBIDDEN", "NOT_FOUND", "CONFLICT", "BAD_REQUEST"])
      .safeParse(error.code);

    if (code.success) throw new ORPCError(code.data, { message: error.message });
  }

  console.error("API operation failed", error);

  if (error instanceof TelemetryUnavailable)
    throw new ORPCError("TELEMETRY_UNAVAILABLE", {
      status: 503,
      message: error.message,
      cause: error,
    });

  throw new ORPCError("SERVICE_UNAVAILABLE", {
    message: "A required service is unavailable",
    cause: error,
  });
};

const idempotencyKey = (request: Request) => {
  const parsed = z.uuid().safeParse(request.headers.get("idempotency-key"));

  if (!parsed.success)
    throw new ORPCError("BAD_REQUEST", { message: "A UUID Idempotency-Key header is required" });

  return parsed.data;
};

export const createApi = (runtime: Runtime) => {
  const base = os.$context<{ request: Request }>().use(async ({ next }) => {
    try {
      return await next();
    } catch (cause) {
      if (
        cause instanceof Error &&
        (!(cause instanceof ORPCError) ||
          (cause.status >= 500 && cause.code !== "TELEMETRY_NOT_CONFIGURED"))
      )
        runtime.reporting.exception(cause.cause instanceof Error ? cause.cause : cause);
      throw cause;
    }
  });

  const read = base.use(async ({ context, next }) => {
    const principal = unwrap(await runtime.identity.authenticate(context.request, "platform:read"));

    if (new URL(context.request.url).pathname !== "/api/v1/reporting/status")
      runtime.reporting.active(principal.id);

    return next({ context: { principal } });
  });

  const write = base.use(async ({ context, next }) => {
    const principal = unwrap(
      await runtime.identity.authenticate(context.request, "platform:write"),
    );

    runtime.reporting.active(principal.id);

    return next({ context: { principal } });
  });

  const agent = base.use(async ({ context, next }) => {
    const authorization = context.request.headers.get("authorization") ?? "";

    if (!authorization.startsWith("Bearer agent_"))
      throw new ORPCError("UNAUTHORIZED", { message: "Agent credentials are required" });

    return next({
      context: { agent: unwrap(await runtime.jobs.authenticate(authorization.slice(7))) },
    });
  });

  const manageNetwork = base.use(async ({ context, next }) => {
    const principal = unwrap(
      await runtime.identity.authenticate(context.request, "network:manage"),
    );

    runtime.reporting.active(principal.id);

    return next({ context: { principal } });
  });

  const leaseInput = z.object({ jobId: contract.identifier, leaseToken: contract.identifier });
  const appAndDeployment = contract.appPath.extend({ deploymentId: contract.identifier });

  const router = {
    reporting: read
      .route({ method: "GET", path: "/reporting" })
      .output(contract.reportingStatus)
      .handler(({ context }) => settingsOperation(() => runtime.reporting.read(context.principal))),
    reportingStatus: read
      .route({ method: "GET", path: "/reporting/status" })
      .output(contract.reportingPreferences)
      .handler(async () => (await runtime.reporting.status()).effective),
    reportingPreview: read
      .route({ method: "GET", path: "/reporting/preview" })
      .output(z.json())
      .handler(({ context }) =>
        settingsOperation(() => runtime.reporting.preview(context.principal)),
      ),
    updateReporting: write
      .route({ method: "PUT", path: "/reporting" })
      .input(contract.reportingPreferences)
      .output(contract.reportingStatus)
      .handler(({ context, input }) =>
        settingsOperation(() => runtime.reporting.update(context.principal, input)),
      ),
    browserError: write
      .route({ method: "POST", path: "/reporting/errors" })
      .input(contract.browserReporting)
      .output(z.object({ accepted: z.boolean() }))
      .handler(({ input }) => {
        runtime.reporting.browser(input);

        return { accepted: true };
      }),
    agentReportingStatus: agent
      .route({ method: "GET", path: "/agent/reporting" })
      .output(contract.reportingPreferences)
      .handler(async () => (await runtime.reporting.status()).effective),
    agentReporting: agent
      .route({ method: "POST", path: "/agent/reporting" })
      .input(contract.agentReporting)
      .output(z.object({ accepted: z.boolean() }))
      .handler(({ input }) => {
        runtime.reporting.agent(input);

        return { accepted: true };
      }),
    connectors: read
      .route({ method: "GET", path: "/connectors" })
      .output(z.array(contract.connectorStatus))
      .handler(async ({ context }) => unwrap(await runtime.connectors.list(context.principal))),
    connectorStatus: read
      .route({ method: "GET", path: "/connectors/{name}" })
      .input(z.strictObject({ name: contract.appSlug }))
      .output(contract.connectorStatus)
      .handler(async ({ context, input }) =>
        unwrap(await runtime.connectors.read(context.principal, input.name)),
      ),
    connectorDeploy: write
      .route({ method: "PUT", path: "/connectors/{name}" })
      .input(contract.connectorPackage)
      .output(contract.connectorStatus)
      .handler(async ({ context, input }) =>
        unwrap(await runtime.connectors.deploy(context.principal, input)),
      ),
    connectorSecrets: read
      .route({ method: "GET", path: "/connectors/{name}/secrets" })
      .input(z.strictObject({ name: contract.appSlug }))
      .output(contract.connectorStatus)
      .handler(async ({ context, input }) =>
        unwrap(await runtime.connectors.read(context.principal, input.name)),
      ),
    connectorSecretPut: write
      .route({ method: "PUT", path: "/connectors/{name}/secrets/{secret}" })
      .input(contract.connectorSecretPath.extend({ value: contract.connectorSecretValue }))
      .output(contract.connectorStatus)
      .handler(async ({ context, input }) =>
        unwrap(
          await runtime.connectors.setSecret(
            context.principal,
            input.name,
            input.secret,
            input.value,
          ),
        ),
      ),
    connectorSecretDelete: write
      .route({ method: "DELETE", path: "/connectors/{name}/secrets/{secret}" })
      .input(contract.connectorSecretPath)
      .output(contract.connectorStatus)
      .handler(async ({ context, input }) =>
        unwrap(
          await runtime.connectors.setSecret(context.principal, input.name, input.secret, null),
        ),
      ),
    connectorBindings: read
      .route({ method: "GET", path: "/apps/{appId}/bindings" })
      .input(contract.appPath)
      .output(contract.capabilityState)
      .handler(async ({ context, input }) =>
        unwrap(await runtime.connectors.bindings(context.principal, input.appId)),
      ),
    connectorBind: write
      .route({ method: "PUT", path: "/apps/{appId}/bindings/{binding}" })
      .input(contract.capabilityPath.extend(contract.capabilityGrant.shape))
      .output(contract.capabilityState)
      .handler(async ({ context, input }) =>
        unwrap(
          await runtime.connectors.bind(context.principal, input.appId, input.binding, {
            connector: input.connector,
            entrypoint: input.entrypoint,
          }),
        ),
      ),
    connectorUnbind: write
      .route({ method: "DELETE", path: "/apps/{appId}/bindings/{binding}" })
      .input(contract.capabilityPath)
      .output(contract.capabilityState)
      .handler(async ({ context, input }) =>
        unwrap(await runtime.connectors.bind(context.principal, input.appId, input.binding, null)),
      ),
    workflowDefinitions: read
      .route({ method: "GET", path: "/apps/{appId}/workflows" })
      .input(contract.appPath)
      .output(z.array(contract.workerBinding))
      .handler(async ({ context, input }) =>
        unwrap(await runtime.workflows.definitions(context.principal, input.appId)),
      ),
    queryWorkflow: read
      .route({ method: "POST", path: "/apps/{appId}/workflows/query" })
      .input(contract.appPath.extend({ request: contract.workflowQuery }))
      .output(contract.workflowOperation)
      .handler(async ({ context, input }) =>
        unwrap(
          await runtime.workflows.create(
            context.principal,
            input.appId,
            idempotencyKey(context.request),
            input.request,
          ),
        ),
      ),
    manageWorkflow: write
      .route({ method: "POST", path: "/apps/{appId}/workflows" })
      .input(contract.appPath.extend({ request: contract.workflowRequest }))
      .output(contract.workflowOperation)
      .handler(async ({ context, input }) =>
        unwrap(
          await runtime.workflows.create(
            context.principal,
            input.appId,
            idempotencyKey(context.request),
            input.request,
          ),
        ),
      ),
    workflowOperation: read
      .route({ method: "GET", path: "/apps/{appId}/workflows/operations/{jobId}" })
      .input(contract.appPath.extend({ jobId: contract.identifier }))
      .output(contract.workflowOperation)
      .handler(async ({ context, input }) =>
        unwrap(await runtime.workflows.read(context.principal, input.appId, input.jobId)),
      ),
    createMigration: write
      .route({ method: "POST", path: "/apps/{appId}/migrations" })
      .input(contract.migrationRequest.safeExtend(contract.appPath.shape))
      .output(contract.migrationOperation)
      .handler(async ({ context, input }) => {
        const { appId, ...migration } = input;

        return unwrap(
          await runtime.migrations.create(
            context.principal,
            appId,
            idempotencyKey(context.request),
            migration,
          ),
        );
      }),
    migration: read
      .route({ method: "GET", path: "/apps/{appId}/migrations/{jobId}" })
      .input(contract.appPath.extend({ jobId: contract.identifier }))
      .output(contract.migrationOperation)
      .handler(async ({ context, input }) =>
        unwrap(await runtime.migrations.read(context.principal, input.appId, input.jobId)),
      ),
    network: read
      .route({ method: "GET", path: "/apps/{appId}/network" })
      .input(contract.appPath)
      .output(contract.networkState)
      .handler(async ({ context, input }) =>
        unwrap(await runtime.network.read(context.principal, input.appId)),
      ),
    changeNetwork: manageNetwork
      .route({ method: "PATCH", path: "/apps/{appId}/network" })
      .input(contract.appPath.extend(contract.networkChange.shape))
      .output(contract.networkState)
      .handler(async ({ context, input }) =>
        unwrap(await runtime.network.change(context.principal, input.appId, input)),
      ),
    setupStatus: base
      .route({ method: "GET", path: "/setup" })
      .output(z.object({ required: z.boolean() }))
      .handler(async () => ({ required: !(await readInstallation(runtime.database.db)).ownerId })),
    setupOwner: base
      .route({ method: "POST", path: "/setup" })
      .input(contract.setupOwner)
      .output(z.object({ id: z.string(), name: z.string(), email: z.string() }))
      .handler(async ({ context, input }) => {
        const origin = context.request.headers.get("origin");

        if (origin !== runtime.configuration.PLATFORM_URL)
          throw new ORPCError("FORBIDDEN", { message: "A same-origin setup request is required" });

        return settingsOperation(() => createInstallationOwner(runtime.database.db, input));
      }),
    getSettings: read
      .route({ method: "GET", path: "/settings" })
      .output(contract.settingsView)
      .handler(({ context }) => settingsOperation(() => runtime.settings.read(context.principal))),
    planSettings: write
      .route({ method: "POST", path: "/settings/plan" })
      .input(contract.settingsInput)
      .output(contract.settingsPlan)
      .handler(({ context, input }) =>
        settingsOperation(() => runtime.settings.plan(context.principal, input)),
      ),
    updateSettings: write
      .route({ method: "PUT", path: "/settings" })
      .input(contract.settingsUpdate)
      .output(contract.settingsView)
      .handler(({ context, input }) =>
        settingsOperation(() =>
          runtime.settings.update(
            context.principal,
            input,
            !context.request.headers.has("authorization"),
          ),
        ),
      ),
    externalManagement: write
      .route({ method: "PUT", path: "/settings/external-management" })
      .input(z.object({ enabled: z.boolean() }))
      .output(contract.settingsView)
      .handler(({ context, input }) =>
        settingsOperation(() =>
          runtime.settings.setExternalManagement(context.principal, input.enabled),
        ),
      ),
    completeSetup: write
      .route({ method: "POST", path: "/settings/complete" })
      .output(contract.settingsView)
      .handler(({ context }) =>
        settingsOperation(() =>
          runtime.settings.complete(context.principal, runtime.auth, context.request.headers),
        ),
      ),
    searchGroups: read
      .route({ method: "GET", path: "/groups" })
      .input(contract.groupSearch)
      .output(contract.groupSearchResult)
      .handler(async ({ context, input }) =>
        unwrap(await runtime.directory.search(context.principal, input)),
      ),
    me: read
      .route({ method: "GET", path: "/me" })
      .output(
        z.object({
          id: z.string(),
          name: z.string(),
          email: z.string(),
          admin: z.boolean(),
          creator: z.boolean(),
        }),
      )
      .handler(({ context }) => context.principal),
    catalog: read
      .route({ method: "GET", path: "/catalog" })
      .output(z.array(contract.catalogEntry))
      .handler(async () => unwrap(await runtime.apps.catalog())),
    setCatalogListing: write
      .route({ method: "PUT", path: "/apps/{appId}/catalog" })
      .input(contract.catalogListingInput)
      .output(contract.catalogListing)
      .handler(async ({ context, input }) =>
        unwrap(await runtime.apps.setCatalogListing(context.principal, input.appId, input.listed)),
      ),
    listApps: read
      .route({ method: "GET", path: "/apps" })
      .output(z.array(contract.app))
      .handler(async ({ context }) => unwrap(await runtime.apps.list(context.principal))),
    createApp: write
      .route({ method: "POST", path: "/apps" })
      .input(contract.createAppInput)
      .output(contract.app)
      .handler(async ({ context, input }) =>
        unwrap(await runtime.apps.create(context.principal, input)),
      ),
    getApp: read
      .route({ method: "GET", path: "/apps/{appId}" })
      .input(contract.appPath)
      .output(contract.app)
      .handler(async ({ context, input }) =>
        unwrap(await runtime.apps.get(context.principal, input.appId)),
      ),
    resolveApp: write
      .route({ method: "PUT", path: "/apps/by-name/{slug}" })
      .input(contract.createAppInput.pick({ slug: true }))
      .output(contract.app)
      .handler(async ({ context, input }) =>
        unwrap(await runtime.apps.resolve(context.principal, input.slug)),
      ),
    findApp: read
      .route({ method: "GET", path: "/apps/by-name/{slug}" })
      .input(z.object({ slug: contract.appSlug }))
      .output(contract.app)
      .handler(async ({ context, input }) => {
        const apps = unwrap(await runtime.apps.list(context.principal));
        const app = apps.find((entry) => entry.slug === input.slug);

        if (!app) throw new ORPCError("NOT_FOUND", { message: "App not found" });

        return app;
      }),
    runtimeLogs: read
      .route({ method: "GET", path: "/apps/{appId}/logs" })
      .errors({
        TELEMETRY_NOT_CONFIGURED: { status: 503 },
        TELEMETRY_UNAVAILABLE: { status: 503 },
      })
      .input(contract.logQuery)
      .output(contract.logPage)
      .handler(async ({ context, input }) =>
        unwrap(await runtime.telemetry.query(context.principal, input)),
      ),
    removeApp: write
      .route({ method: "DELETE", path: "/apps/{appId}" })
      .input(contract.appPath)
      .output(z.object({ accepted: z.boolean() }))
      .handler(async ({ context, input }) =>
        unwrap(await runtime.apps.remove(context.principal, input.appId)),
      ),
    appAccess: read
      .route({ method: "GET", path: "/apps/{appId}/access" })
      .input(contract.appPath)
      .output(contract.appAccessState)
      .handler(async ({ context, input }) =>
        unwrap(await runtime.appAccess.read(context.principal, input.appId)),
      ),
    changeAppAccess: write
      .route({ method: "PATCH", path: "/apps/{appId}/access" })
      .input(contract.appPath.extend(contract.appAccessChange.shape))
      .output(contract.appAccessState)
      .handler(async ({ context, input }) =>
        unwrap(await runtime.appAccess.change(context.principal, input.appId, input)),
      ),
    appRoles: read
      .route({ method: "GET", path: "/apps/{appId}/roles" })
      .input(contract.appPath)
      .output(contract.appRoleState)
      .handler(async ({ context, input }) =>
        unwrap(await runtime.appAccess.roles(context.principal, input.appId)),
      ),
    roleCandidates: read
      .route({ method: "GET", path: "/apps/{appId}/roles/candidates" })
      .input(contract.appPath.extend({ search: z.string().trim().min(1).max(200) }))
      .output(
        z.array(
          z.object({ name: z.string(), email: z.string(), principal: contract.appPrincipal }),
        ),
      )
      .handler(async ({ context, input }) =>
        unwrap(await runtime.appAccess.candidates(context.principal, input.appId, input.search)),
      ),
    grantRole: write
      .route({ method: "POST", path: "/apps/{appId}/roles" })
      .input(contract.appPath.extend(contract.appRoleGrant.shape))
      .output(contract.appRoleState)
      .handler(async ({ context, input }) =>
        unwrap(await runtime.appAccess.grant(context.principal, input.appId, input)),
      ),
    revokeRole: write
      .route({ method: "DELETE", path: "/apps/{appId}/roles/{assignmentId}" })
      .input(contract.appPath.extend(contract.appRoleRevoke.shape))
      .output(contract.appRoleState)
      .handler(async ({ context, input }) =>
        unwrap(await runtime.appAccess.revoke(context.principal, input.appId, input)),
      ),
    history: read
      .route({ method: "GET", path: "/apps/{appId}/deployments" })
      .input(contract.appPath)
      .output(z.array(contract.deployment))
      .handler(async ({ context, input }) =>
        unwrap(await runtime.apps.history(context.principal, input.appId)),
      ),
    events: read
      .route({ method: "GET", path: "/apps/{appId}/deployments/{deploymentId}/events" })
      .input(appAndDeployment)
      .output(z.array(contract.deploymentEvent))
      .handler(async ({ context, input }) =>
        unwrap(await runtime.apps.events(context.principal, input.appId, input.deploymentId)),
      ),
    rollback: write
      .route({ method: "POST", path: "/apps/{appId}/rollback" })
      .input(contract.appPath.extend(contract.rollbackInput.shape))
      .output(contract.deployment)
      .handler(async ({ context, input }) =>
        unwrap(
          await runtime.apps.rollback(
            context.principal,
            input.appId,
            input.artifactId,
            idempotencyKey(context.request),
          ),
        ),
      ),
    listAgents: read
      .route({ method: "GET", path: "/agents" })
      .output(z.array(contract.agent))
      .handler(async ({ context }) => unwrap(await runtime.agents.list(context.principal))),
    createAgent: write
      .route({ method: "POST", path: "/agents" })
      .input(contract.createAgentInput)
      .output(z.object({ agent: contract.agent, token: z.string() }))
      .handler(async ({ context, input }) =>
        unwrap(await runtime.agents.create(context.principal, input)),
      ),
    disableAgent: write
      .route({ method: "DELETE", path: "/agents/{agentId}" })
      .input(z.object({ agentId: contract.identifier }))
      .output(contract.agent)
      .handler(async ({ context, input }) =>
        unwrap(await runtime.agents.disable(context.principal, input.agentId)),
      ),
    startUpload: write
      .route({ method: "POST", path: "/apps/{appId}/assets-upload-session" })
      .input(contract.appPath.extend(contract.createUploadInput.shape))
      .output(contract.uploadSession)
      .handler(async ({ context, input }) =>
        unwrap(await runtime.uploads.start(context.principal, input.appId, input.manifest)),
      ),
    runtimeStatus: read
      .route({ method: "GET", path: "/runtime" })
      .output(contract.runtimeStatus)
      .handler(async ({ context }) => unwrap(await runtime.releases.read(context.principal))),
    installRuntime: write
      .route({ method: "PUT", path: "/runtime" })
      .input(contract.runtimeRelease)
      .output(contract.runtimeStatus)
      .handler(async ({ context, input }) =>
        unwrap(await runtime.releases.install(context.principal, input)),
      ),
    rollbackRuntime: write
      .route({ method: "POST", path: "/runtime/rollback" })
      .input(contract.runtimeUpdate)
      .output(contract.runtimeStatus)
      .handler(async ({ context, input }) =>
        unwrap(await runtime.releases.rollback(context.principal, input)),
      ),
    runtimePackages: agent
      .route({ method: "GET", path: "/agent/jobs/{jobId}/packages" })
      .input(leaseInput)
      .output(contract.runtimePackages)
      .handler(async ({ context, input }) =>
        unwrap(await runtime.jobs.packages(context.agent.id, input.jobId, input.leaseToken)),
      ),
    claimJob: agent
      .route({ method: "POST", path: "/agent/jobs/claim" })
      .input(
        z.object({ accessRules: z.union([z.literal(1), z.literal(2)]).optional() }).default({}),
      )
      .output(contract.job.nullable())
      .handler(async ({ context, input }) =>
        unwrap(await runtime.jobs.claim(context.agent.id, input.accessRules === 2)),
      ),
    heartbeat: agent
      .route({ method: "POST", path: "/agent/jobs/{jobId}/heartbeat" })
      .input(leaseInput.extend(contract.jobUpdate.shape))
      .output(z.object({ leaseUntil: z.iso.datetime() }))
      .handler(async ({ context, input }) =>
        unwrap(await runtime.jobs.heartbeat(context.agent.id, input.jobId, input)),
      ),
    log: agent
      .route({ method: "POST", path: "/agent/jobs/{jobId}/events" })
      .input(leaseInput.extend(contract.jobUpdate.shape))
      .output(z.object({ recorded: z.boolean() }))
      .handler(async ({ context, input }) =>
        unwrap(await runtime.jobs.log(context.agent.id, input.jobId, input)),
      ),
    complete: agent
      .route({ method: "POST", path: "/agent/jobs/{jobId}/complete" })
      .input(leaseInput.extend(contract.jobResult.shape))
      .output(z.object({ accepted: z.boolean() }))
      .handler(async ({ context, input }) => {
        const { jobId, ...result } = input;

        return unwrap(await runtime.jobs.complete(context.agent.id, jobId, result));
      }),
    artifact: agent
      .route({ method: "GET", path: "/agent/jobs/{jobId}/artifact" })
      .input(leaseInput)
      .output(contract.artifact)
      .handler(async ({ context, input }) =>
        unwrap(await runtime.jobs.artifact(context.agent.id, input.jobId, input.leaseToken)),
      ),
    telemetryCredentials: agent
      .route({ method: "GET", path: "/agent/jobs/{jobId}/telemetry" })
      .input(leaseInput)
      .output(contract.telemetryCredentials)
      .handler(async ({ context, input }) => {
        const artifact = unwrap(
          await runtime.jobs.artifact(context.agent.id, input.jobId, input.leaseToken),
        );

        return runtime.telemetry.credentials(artifact.appId);
      }),
  };

  const handler = new OpenAPIHandler(router);
  const generator = new OpenAPIGenerator({ schemaConverters: [new ZodToJsonSchemaConverter()] });

  const dispatch = async (request: Request) => {
    const url = new URL(request.url);
    const telemetry = /^\/api\/v1\/telemetry\/([^/]+)\/v1\/(logs|traces)$/.exec(url.pathname);

    if (telemetry && request.method === "POST")
      return runtime.telemetry.ingest(
        request,
        contract.identifier.parse(telemetry[1]),
        z.enum(["logs", "traces"]).parse(telemetry[2]),
      );

    if (url.pathname === "/api/v1/openapi.json" && request.method === "GET") {
      unwrap(await runtime.identity.authenticate(request, "platform:read"));

      const document = await generator.generate(router, {
        info: { title: "App Platform API", version: "1.0.0" },
        servers: [{ url: `${runtime.configuration.PLATFORM_URL}/api/v1` }],
        security: [{ bearer: [] }],
        components: {
          securitySchemes: {
            bearer: {
              type: "http",
              scheme: "bearer",
              description:
                "CLI OAuth access token with platform:read, platform:write or network:manage scope. Network changes also require app-admin or installation-administrator access. Agent endpoints require a separate agent token.",
            },
          },
        },
      });

      return Response.json({
        ...document,
        paths: { ...document.paths, ...binaryPaths },
        components: {
          ...document.components,
          schemas: { ...document.components?.schemas, ...binarySchemas },
        },
      });
    }

    const upload = /^\/api\/v1\/apps\/([^/]+)\/(worker|assets\/([^/]+)\/([^/]+))$/.exec(
      url.pathname,
    );

    if (upload && request.method === "PUT") {
      const principal = unwrap(await runtime.identity.authenticate(request, "platform:write"));
      const appId = contract.identifier.parse(upload[1]);

      if (upload[2] === "worker") {
        const key = idempotencyKey(request);
        const { metadata, modules } = unwrap(await parseWorkerUpload(request));

        return Response.json(
          unwrap(await runtime.uploads.publish(principal, appId, metadata, modules, key)),
        );
      }

      const sessionId = contract.identifier.parse(upload[3]);
      const hash = contract.assetHash.parse(upload[4]);
      const bytes = unwrap(await readBody(request, 25 * 1024 * 1024));

      return Response.json(
        unwrap(await runtime.uploads.putAsset(principal, appId, sessionId, hash, bytes)),
      );
    }

    const download = /^\/api\/v1\/agent\/jobs\/([^/]+)\/(assets|modules|migrations)\/([^/]+)$/.exec(
      url.pathname,
    );

    if (download && request.method === "GET") {
      const credentials = request.headers.get("authorization") ?? "";

      if (!credentials.startsWith("Bearer agent_")) throw new ORPCError("UNAUTHORIZED");
      const agent = unwrap(await runtime.jobs.authenticate(credentials.slice(7)));
      const jobId = contract.identifier.parse(download[1]);
      const leaseToken = contract.identifier.parse(url.searchParams.get("leaseToken"));

      if (download[2] === "migrations") {
        const bytes = unwrap(
          await runtime.jobs.migrationArtifact(
            agent.id,
            jobId,
            leaseToken,
            contract.checksum.parse(download[3]),
          ),
        );

        return new Response(Buffer.from(bytes), {
          headers: { "content-type": "application/octet-stream", "cache-control": "no-store" },
        });
      }

      const artifact = unwrap(await runtime.jobs.artifact(agent.id, jobId, leaseToken));

      const hash =
        download[2] === "assets"
          ? contract.assetHash.parse(download[3])
          : contract.checksum.parse(download[3]);

      const allowed =
        download[2] === "assets"
          ? Object.values(artifact.manifest).some((entry) => entry.hash === hash)
          : artifact.modules.some((module) => module.sha256 === hash);

      if (!allowed) throw new ORPCError("NOT_FOUND");

      const bytes = unwrap(
        await runtime.storage.get(`apps/${artifact.appId}/${download[2]}/${hash}`),
      );

      return new Response(Buffer.from(bytes), {
        headers: { "content-type": "application/octet-stream", "cache-control": "no-store" },
      });
    }

    if (
      request.method === "POST" &&
      ["/api/v1/reporting/errors", "/api/v1/agent/reporting"].includes(url.pathname)
    ) {
      const bytes = unwrap(await readBody(request, 16 * 1024));
      request = new Request(request.url, {
        method: request.method,
        headers: request.headers,
        body: Buffer.from(bytes),
      });
    }

    const response = await handler.handle(request, { prefix: "/api/v1", context: { request } });

    return response.matched ? response.response : new Response("Not found", { status: 404 });
  };

  return async (request: Request) => {
    try {
      const response = await dispatch(request);
      response.headers.set("cache-control", "no-store");

      return response;
    } catch (cause) {
      if (cause instanceof ORPCError)
        return Response.json(
          { code: z.string().parse(cause.code), message: cause.message },
          { status: cause.status },
        );

      if (cause instanceof z.ZodError)
        return Response.json(
          { code: "BAD_REQUEST", message: "Invalid request parameters" },
          { status: 400 },
        );
      console.error("Request failed", cause);

      if (cause instanceof Error) runtime.reporting.exception(cause);

      return Response.json(
        { code: "INTERNAL_SERVER_ERROR", message: "The request could not be completed" },
        { status: 500 },
      );
    }
  };
};
