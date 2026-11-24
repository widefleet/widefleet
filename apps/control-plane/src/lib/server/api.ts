import { APIError } from "better-auth/api";
import { OpenAPIHandler } from "@orpc/openapi/fetch";
import { OpenAPIGenerator } from "@orpc/openapi";
import { ORPCError, ValidationError, onError, os } from "@orpc/server";
import { ZodToJsonSchemaConverter } from "@orpc/zod/zod4";
import * as contract from "@platform/contracts";
import type { Result } from "better-result";
import { z } from "zod";
import type { Runtime } from "./runtime.ts";
import type { Principal } from "./identity.ts";
import { parseWorkerUpload, readBody } from "./upload-body.ts";
import { binaryPaths, binarySchemas } from "./openapi-binary.ts";
import { DirectoryUnavailable } from "./directory.ts";
import { InvalidOperation, TelemetryNotConfigured, TelemetryUnavailable } from "./errors.ts";
import { readInstallation } from "./installation-store.ts";
import { templateCatalog, readTemplate, readTemplateIcon } from "./app-templates.ts";
import { iconCache, iconResponse, missingIconResponse, readAppIcon } from "./app-icons.ts";
import { findAppScreenshot } from "./app-screenshots.ts";

import { changeMemberRole, listMembers, removeMember } from "./members.ts";
import { readCompanyAccount } from "./settings-account.ts";

const apiOperation = async <T>(operation: () => Promise<T>) => {
  try {
    return await operation();
  } catch (cause) {
    if (cause instanceof InvalidOperation)
      throw new ORPCError(cause.code, { message: cause.message });

    if (cause instanceof APIError)
      throw new ORPCError("AUTH_OPERATION_FAILED", {
        status: cause.statusCode,
        message: cause.message,
        cause,
      });
    throw cause;
  }
};

const unwrap = <T, E extends { message: string }>(result: Result<T, E>) => {
  if (result.isOk()) return result.value;
  const error = result.error;

  if (error instanceof APIError)
    throw new ORPCError("AUTH_OPERATION_FAILED", {
      status: error.statusCode,
      message: error.message,
      cause: error,
    });

  if (error instanceof DirectoryUnavailable)
    throw new ORPCError("SERVICE_UNAVAILABLE", { message: error.message, cause: error });

  if (error instanceof TelemetryNotConfigured)
    throw new ORPCError("TELEMETRY_NOT_CONFIGURED", { status: 503, message: error.message });

  if ("code" in error) {
    if (error.code === "ORGANIZATION_REQUIRED" || error.code === "SSO_REQUIRED")
      throw new ORPCError(error.code, { status: 403, message: error.message });

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
  const principals = new WeakMap<Request, Principal>();

  const reportException = (error: Error, request: Request) => {
    const principal = principals.get(request);
    runtime.reporting.exception(error, principal ? `user:${principal.id}` : undefined, {
      $groups: principal ? { organization: principal.application.organizationId } : undefined,
    });
  };

  const base = os.$context<{ request: Request }>().use(async ({ context, next }) => {
    try {
      return await next();
    } catch (cause) {
      if (
        cause instanceof Error &&
        (!(cause instanceof ORPCError) ||
          (cause.status >= 500 && cause.code !== "TELEMETRY_NOT_CONFIGURED"))
      )
        reportException(cause.cause instanceof Error ? cause.cause : cause, context.request);
      throw cause;
    }
  });

  const authenticateWrite = async (request: Request) => {
    const principal = unwrap(await runtime.identity.authenticate(request, "platform:write"));
    principals.set(request, principal);
    runtime.reporting.active(principal.id);

    return principal;
  };

  const read = base.use(async ({ context, next }) => {
    const principal = unwrap(await runtime.identity.authenticate(context.request, "platform:read"));
    principals.set(context.request, principal);

    runtime.reporting.active(principal.id);

    return next({ context: { principal } });
  });

  const write = base.use(async ({ context, next }) => {
    const principal = await authenticateWrite(context.request);

    return next({ context: { principal } });
  });

  // Installation-wide endpoints only need a signed-in person, so browsers can call them
  // without naming an organization.
  const signedInRead = base.use(async ({ context, next }) => {
    unwrap(await runtime.identity.authenticateUser(context.request, "platform:read"));

    return next();
  });

  const signedInWrite = base.use(async ({ context, next }) => {
    const verified = unwrap(
      await runtime.identity.authenticateUser(context.request, "platform:write"),
    );

    runtime.reporting.active(verified.userId);

    return next();
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

    principals.set(context.request, principal);

    runtime.reporting.active(principal.id);

    return next({ context: { principal } });
  });

  const leaseInput = z.object({ jobId: contract.identifier, leaseToken: contract.identifier });
  const appAndDeployment = contract.appPath.extend({ deploymentId: contract.identifier });

  const router = {
    account: read
      .route({ method: "GET", path: "/account" })
      .output(contract.companyAccount)
      .handler(async ({ context }) =>
        readCompanyAccount(
          runtime,
          context.principal,
          (await runtime.auth.api.getSession({ headers: context.request.headers }))?.session ??
            null,
        ),
      ),
    organizations: base
      .route({ method: "GET", path: "/organizations" })
      .output(z.array(contract.organizationChoice))
      .handler(async ({ context }) =>
        unwrap(await runtime.identity.organizations(context.request)),
      ),
    createOrganization: base
      .route({ method: "POST", path: "/organizations" })
      .input(contract.organizationCreation)
      .output(contract.onboardingOrganization)
      .handler(async ({ context, input }) =>
        apiOperation(async () =>
          runtime.onboarding.create(
            unwrap(await runtime.identity.authenticateUser(context.request, "platform:write")),
            input,
          ),
        ),
      ),
    joinableOrganizations: base
      .route({ method: "GET", path: "/organizations/joinable" })
      .output(z.array(contract.joinableOrganization))
      .handler(async ({ context }) =>
        apiOperation(async () =>
          runtime.domainAccess.joinable(
            unwrap(await runtime.identity.authenticateUser(context.request, "platform:read")),
          ),
        ),
      ),
    joinOrganization: base
      .route({ method: "POST", path: "/organizations/{organizationId}/join" })
      .input(contract.organizationSelection)
      .output(contract.organizationSelection)
      .handler(async ({ context, input }) =>
        apiOperation(async () => {
          const joined = await runtime.domainAccess.join(
            unwrap(await runtime.identity.authenticateUser(context.request, "platform:write")),
            input.organizationId,
          );

          return { organizationId: joined.organizationId };
        }),
      ),
    members: read
      .route({ method: "GET", path: "/members" })
      .input(
        contract.memberQuery.extend({
          page: z.coerce.number().pipe(contract.memberQuery.shape.page.removeDefault()).default(1),
        }),
      )
      .output(contract.memberPage)
      .handler(({ context, input }) =>
        apiOperation(async () =>
          unwrap(
            await listMembers(runtime.database.db, context.principal, input.search, input.page),
          ),
        ),
      ),
    changeMember: write
      .route({ method: "PATCH", path: "/members/{memberId}" })
      .input(contract.memberRoleInput)
      .output(z.object({ changed: z.boolean() }))
      .handler(async ({ context, input }) =>
        unwrap(
          await changeMemberRole(context.principal, input, {
            auth: runtime.auth,
            headers: context.request.headers,
          }),
        ),
      ),
    removeMember: write
      .route({ method: "DELETE", path: "/members/{memberId}" })
      .input(contract.memberPath)
      .output(z.object({ changed: z.boolean() }))
      .handler(async ({ context, input }) =>
        unwrap(
          await removeMember(context.principal, input.memberId, {
            auth: runtime.auth,
            headers: context.request.headers,
          }),
        ),
      ),
    invitations: read
      .route({ method: "GET", path: "/invitations" })
      .output(z.array(contract.invitationEntry))
      .handler(({ context }) => apiOperation(() => runtime.invitations.list(context.principal))),
    invite: write
      .route({ method: "POST", path: "/invitations" })
      .input(contract.invitationInput)
      .output(contract.invitationEntry)
      .handler(({ context, input }) =>
        apiOperation(() =>
          runtime.invitations.invite(context.principal, input, {
            auth: runtime.auth,
            headers: context.request.headers,
          }),
        ),
      ),
    cancelInvitation: write
      .route({ method: "DELETE", path: "/invitations/{invitationId}" })
      .input(contract.invitationPath)
      .output(z.object({ canceled: z.boolean() }))
      .handler(({ context, input }) =>
        apiOperation(() =>
          runtime.invitations.cancel(context.principal, input.invitationId, {
            auth: runtime.auth,
            headers: context.request.headers,
          }),
        ),
      ),
    invitation: base
      .route({ method: "GET", path: "/invitations/{invitationId}" })
      .input(contract.invitationPath)
      .output(contract.invitationDetails)
      .handler(({ context, input }) =>
        apiOperation(async () => {
          const person = unwrap(
            await runtime.identity.authenticateUser(context.request, "platform:read"),
          );

          return runtime.invitations.read(person, input.invitationId);
        }),
      ),
    acceptInvitation: base
      .route({ method: "POST", path: "/invitations/{invitationId}/accept" })
      .input(contract.invitationAcceptance)
      .output(contract.organizationSelection)
      .handler(({ context, input }) =>
        apiOperation(() =>
          runtime.invitations.accept(input.invitationId, {
            auth: runtime.auth,
            headers: context.request.headers,
          }),
        ),
      ),
    reporting: read
      .route({ method: "GET", path: "/reporting" })
      .output(contract.reportingStatus)
      .handler(({ context }) => apiOperation(() => runtime.reporting.read(context.principal))),
    reportingStatus: signedInRead
      .route({ method: "GET", path: "/reporting/status" })
      .output(contract.reportingPreferences)
      .handler(async () => (await runtime.reporting.status()).effective),
    reportingPreview: read
      .route({ method: "GET", path: "/reporting/preview" })
      .output(z.json())
      .handler(({ context }) => apiOperation(() => runtime.reporting.preview(context.principal))),
    updateReporting: write
      .route({ method: "PUT", path: "/reporting" })
      .input(contract.reportingPreferences)
      .output(contract.reportingStatus)
      .handler(({ context, input }) =>
        apiOperation(() => runtime.reporting.update(context.principal, input)),
      ),
    browserError: signedInWrite
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
    appSecrets: read
      .route({ method: "GET", path: "/apps/{appId}/secrets" })
      .input(contract.appPath)
      .output(contract.appSecretStatus)
      .handler(async ({ context, input }) =>
        unwrap(await runtime.appSecrets.read(context.principal, input.appId)),
      ),
    appSecretPut: write
      .route({ method: "PUT", path: "/apps/{appId}/secrets/{secret}" })
      .input(
        contract.appPath.extend({
          secret: contract.appSecretName,
          value: contract.appSecretValue,
        }),
      )
      .output(contract.appSecretStatus)
      .handler(async ({ context, input }) =>
        unwrap(
          await runtime.appSecrets.set(context.principal, input.appId, input.secret, input.value),
        ),
      ),
    appSecretDelete: write
      .route({ method: "DELETE", path: "/apps/{appId}/secrets/{secret}" })
      .input(contract.appPath.extend({ secret: contract.appSecretName }))
      .output(contract.appSecretStatus)
      .handler(async ({ context, input }) =>
        unwrap(await runtime.appSecrets.set(context.principal, input.appId, input.secret, null)),
      ),
    serviceCatalog: read
      .route({ method: "GET", path: "/app-services" })
      .output(z.array(contract.serviceCatalogEntry))
      .handler(async ({ context }) =>
        unwrap(await runtime.connections.services(context.principal)),
      ),
    serviceDescription: read
      .route({ method: "GET", path: "/app-services/{service}" })
      .input(contract.serviceDescriptionQuery)
      .output(contract.serviceDescription)
      .handler(async ({ context, input }) =>
        unwrap(
          await runtime.connections.describe(context.principal, input.service, {
            entrypoint: input.entrypoint,
            methods: input.methods,
            types: input.types,
          }),
        ),
      ),
    serviceBindingTypes: read
      .route({ method: "GET", path: "/app-services/{service}/types" })
      .input(contract.serviceBindingTypesQuery)
      .output(contract.serviceBindingTypesResult)
      .handler(async ({ context, input }) =>
        unwrap(
          await runtime.connections.types(context.principal, input.service, {
            entrypoint: input.entrypoint,
            binding: input.binding,
          }),
        ),
      ),
    appConnections: read
      .route({ method: "GET", path: "/apps/{appId}/connections" })
      .input(contract.appPath)
      .output(contract.appConnections)
      .handler(async ({ context, input }) =>
        unwrap(await runtime.connections.connections(context.principal, input.appId)),
      ),
    appBindings: read
      .route({ method: "GET", path: "/apps/{appId}/bindings" })
      .input(contract.appPath)
      .output(contract.capabilityState)
      .handler(async ({ context, input }) =>
        unwrap(await runtime.connections.bindings(context.principal, input.appId)),
      ),
    appBind: write
      .route({ method: "PUT", path: "/apps/{appId}/bindings/{binding}" })
      .input(contract.capabilityPath.extend(contract.capabilityGrant.shape))
      .output(contract.capabilityState)
      .handler(async ({ context, input }) =>
        unwrap(
          await runtime.connections.bind(
            context.principal,
            input.appId,
            input.binding,
            contract.capabilityGrant.parse({
              app: input.app,
              entrypoint: input.entrypoint,
            }),
          ),
        ),
      ),
    appUnbind: write
      .route({ method: "DELETE", path: "/apps/{appId}/bindings/{binding}" })
      .input(contract.capabilityPath)
      .output(contract.capabilityState)
      .handler(async ({ context, input }) =>
        unwrap(await runtime.connections.bind(context.principal, input.appId, input.binding, null)),
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
      .handler(async ({ context, input }) => {
        const { appId, ...change } = input;

        return unwrap(await runtime.network.change(context.principal, appId, change));
      }),
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

        return apiOperation(() => runtime.settings.createOwner(input));
      }),
    getSettings: read
      .route({ method: "GET", path: "/settings" })
      .output(contract.settingsView)
      .handler(({ context }) => apiOperation(() => runtime.settings.read(context.principal))),
    planSettings: write
      .route({ method: "POST", path: "/settings/plan" })
      .input(contract.settingsInput)
      .output(contract.settingsPlan)
      .handler(({ context, input }) =>
        apiOperation(() => runtime.settings.plan(context.principal, input)),
      ),
    updateSettings: write
      .route({ method: "PUT", path: "/settings" })
      .input(contract.settingsUpdate)
      .output(contract.settingsView)
      .handler(({ context, input }) =>
        apiOperation(() =>
          runtime.settings.update(
            context.principal,
            input,
            !context.request.headers.has("authorization"),
            { auth: runtime.auth, headers: context.request.headers },
          ),
        ),
      ),
    externalManagement: write
      .route({ method: "PUT", path: "/settings/external-management" })
      .input(z.object({ enabled: z.boolean() }))
      .output(contract.settingsView)
      .handler(({ context, input }) =>
        apiOperation(() =>
          runtime.settings.setExternalManagement(context.principal, input.enabled),
        ),
      ),
    domainSso: write
      .route({ method: "PUT", path: "/settings/domain-sso" })
      .input(z.object({ enabled: z.boolean() }))
      .output(contract.settingsView)
      .handler(({ context, input }) =>
        apiOperation(() =>
          runtime.settings.setDomainSso(
            context.principal,
            input.enabled,
            !context.request.headers.has("authorization"),
          ),
        ),
      ),
    domainVerification: write
      .route({ method: "POST", path: "/settings/domain-verification" })
      .output(contract.domainVerification)
      .handler(({ context }) =>
        apiOperation(() => runtime.settings.domainVerification(context.principal)),
      ),
    addDomain: write
      .route({ method: "POST", path: "/settings/domains" })
      .input(contract.ssoDomainInput)
      .output(contract.settingsView)
      .handler(({ context, input }) =>
        apiOperation(() =>
          runtime.settings.addDomain(
            context.principal,
            input.domain,
            !context.request.headers.has("authorization"),
          ),
        ),
      ),
    removeDomain: write
      .route({ method: "DELETE", path: "/settings/domains/{domain}" })
      .input(contract.ssoDomainInput)
      .output(contract.settingsView)
      .handler(({ context, input }) =>
        apiOperation(() =>
          runtime.settings.removeDomain(
            context.principal,
            input.domain,
            !context.request.headers.has("authorization"),
          ),
        ),
      ),
    verifyDomain: write
      .route({ method: "POST", path: "/settings/verify-domain" })
      .input(contract.ssoDomainInput.partial().optional())
      .output(z.object({ success: z.boolean() }))
      .handler(({ context, input }) =>
        apiOperation(() => runtime.settings.verifyDomain(context.principal, input?.domain)),
      ),
    activateSso: write
      .route({ method: "POST", path: "/settings/activate-sso" })
      .output(contract.settingsView)
      .handler(({ context }) =>
        apiOperation(() => runtime.settings.activateSso(context.principal)),
      ),
    domainAccess: read
      .route({ method: "GET", path: "/settings/domain-access" })
      .output(contract.domainAccess)
      .handler(({ context }) => apiOperation(() => runtime.domainAccess.read(context.principal))),
    addJoinDomain: write
      .route({ method: "POST", path: "/settings/join-domains" })
      .input(contract.joinDomainInput)
      .output(contract.domainAccess)
      .handler(({ context, input }) =>
        apiOperation(() => runtime.domainAccess.addJoinDomain(context.principal, input.domain)),
      ),
    removeJoinDomain: write
      .route({ method: "DELETE", path: "/settings/join-domains/{domain}" })
      .input(contract.joinDomainInput)
      .output(contract.domainAccess)
      .handler(({ context, input }) =>
        apiOperation(() => runtime.domainAccess.removeJoinDomain(context.principal, input.domain)),
      ),
    restrictOrganizationCreation: write
      .route({ method: "PUT", path: "/settings/organization-creation" })
      .input(contract.organizationCreationRestriction)
      .output(contract.domainAccess)
      .handler(({ context, input }) =>
        apiOperation(() =>
          runtime.domainAccess.restrictOrganizationCreation(context.principal, input.restricted),
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
      .output(contract.currentUser)
      .handler(({ context }) => context.principal),
    userConnections: read
      .route({ method: "GET", path: "/user-connections" })
      .output(z.array(contract.userConnectionEntry))
      .handler(({ context }) =>
        apiOperation(() => runtime.userConnections.list(context.principal)),
      ),
    prepareUserConnection: write
      .route({ method: "POST", path: "/user-connections/{appId}/connect" })
      .input(contract.userConnectionInput)
      .output(contract.userConnectionLaunch)
      .handler(({ context, input }) =>
        apiOperation(() => runtime.userConnections.prepare(context.principal, input.appId)),
      ),
    disconnectUserConnection: write
      .route({ method: "DELETE", path: "/user-connections/{appId}" })
      .input(contract.userConnectionInput)
      .output(z.strictObject({ disconnected: z.literal(true) }))
      .handler(({ context, input }) =>
        apiOperation(() => runtime.userConnections.disconnect(context.principal, input.appId)),
      ),
    catalog: read
      .route({ method: "GET", path: "/catalog" })
      .output(z.array(contract.catalogEntry))
      .handler(async ({ context }) => unwrap(await runtime.apps.catalog(context.principal))),
    catalogApp: read
      .route({ method: "GET", path: "/catalog/apps/{appId}" })
      .input(contract.appPath)
      .output(contract.catalogApp)
      .handler(async ({ context, input }) =>
        unwrap(await runtime.apps.listing(context.principal, input.appId)),
      ),
    listTemplates: read
      .route({ method: "GET", path: "/catalog/templates" })
      .input(contract.templateSearch)
      .output(contract.appTemplateCatalog)
      .handler(async ({ context, input }) =>
        unwrap(
          await templateCatalog(
            context.principal,
            runtime.configuration,
            unwrap(await runtime.apps.templateInstalls(context.principal)),
            input.search,
          ),
        ),
      ),
    getTemplate: read
      .route({ method: "GET", path: "/catalog/templates/{templateId}" })
      .input(contract.templatePath)
      .output(contract.appTemplate)
      .handler(async ({ context, input }) =>
        unwrap(
          await readTemplate(
            context.principal,
            runtime.configuration,
            input.templateId,
            runtime.templates.available,
            unwrap(await runtime.apps.templateInstalls(context.principal)),
          ),
        ),
      ),
    installTemplate: write
      .route({ method: "POST", path: "/catalog/templates/{templateId}/install" })
      .input(contract.templateInstallInput)
      .output(contract.templateInstall)
      .handler(async ({ context, input }) => {
        // As `widefleet network allow`, granting the template's declared
        // origins requires the network:manage scope; without it they stay
        // requested.
        const manage = await runtime.identity.authenticate(context.request, "network:manage");

        return unwrap(
          await runtime.templates.install(
            context.principal,
            input,
            manage.isOk() ? { consentedNetwork: "declared" } : {},
          ),
        );
      }),
    setCatalogListing: write
      .route({ method: "PUT", path: "/apps/{appId}/catalog" })
      .input(contract.catalogListingInput)
      .output(contract.catalogListing)
      .handler(async ({ context, input }) =>
        unwrap(await runtime.apps.setCatalogListing(context.principal, input.appId, input.listed)),
      ),
    renameApp: write
      .route({ method: "PUT", path: "/apps/{appId}/name" })
      .input(contract.appNameInput)
      .output(contract.appNameChange)
      .handler(async ({ context, input }) =>
        unwrap(await runtime.apps.rename(context.principal, input.appId, input.displayName)),
      ),
    setAppDescription: write
      .route({ method: "PUT", path: "/apps/{appId}/description" })
      .input(contract.appDescriptionInput)
      .output(contract.app.pick({ description: true }))
      .handler(async ({ context, input }) =>
        unwrap(
          await runtime.apps.setDescription(context.principal, input.appId, input.description),
        ),
      ),
    setAppAbout: write
      .route({ method: "PUT", path: "/apps/{appId}/about" })
      .input(contract.appAboutInput)
      .output(contract.app.pick({ about: true }))
      .handler(async ({ context, input }) =>
        unwrap(await runtime.apps.setAbout(context.principal, input.appId, input.about)),
      ),
    sourceDeployTarget: write
      // Deployment tokens need this read-only check without platform:read scope.
      .route({ method: "POST", path: "/apps/source-target" })
      .input(contract.sourceDeployTargetInput)
      .output(contract.sourceDeployTarget)
      .handler(async ({ context, input }) =>
        unwrap(await runtime.source.deploymentTarget(context.principal, input)),
      ),
    appSource: read
      .route({ method: "GET", path: "/apps/{appId}/source" })
      .input(contract.appPath)
      .output(contract.appSource)
      .handler(async ({ context, input }) =>
        unwrap(await runtime.source.read(context.principal, input.appId)),
      ),
    prepareSource: write
      .route({ method: "POST", path: "/apps/{appId}/source/prepare" })
      .input(contract.appPath.strict())
      .output(contract.sourcePreparation)
      .handler(async ({ context, input }) =>
        unwrap(await runtime.source.prepare(context.principal, input.appId)),
      ),
    sourceReadCredential: read
      .route({ method: "POST", path: "/apps/{appId}/source/read-credential" })
      .input(contract.appPath)
      .output(contract.sourceCredential)
      .handler(async ({ context, input }) =>
        unwrap(await runtime.source.credential(context.principal, input.appId, "read")),
      ),
    sourceWriteCredential: write
      .route({ method: "POST", path: "/apps/{appId}/source/write-credential" })
      .input(contract.appPath)
      .output(contract.sourceCredential)
      .handler(async ({ context, input }) =>
        unwrap(await runtime.source.credential(context.principal, input.appId, "write")),
      ),
    listApps: read
      .route({ method: "GET", path: "/apps" })
      .output(z.array(contract.appListEntry))
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
      .output(contract.appListEntry)
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
      .handler(async ({ context, input }) => {
        const { appId, ...change } = input;

        return unwrap(await runtime.appAccess.change(context.principal, appId, change));
      }),
    grant: write
      .route({ method: "PUT", path: "/apps/{appId}/creators/{userId}" })
      .input(contract.appPath.extend({ userId: z.string().min(1).max(128) }))
      .output(z.object({ granted: z.boolean() }))
      .handler(async ({ context, input }) =>
        unwrap(await runtime.apps.grant(context.principal, input.appId, input.userId)),
      ),
    history: read
      .route({ method: "GET", path: "/apps/{appId}/deployments" })
      .input(contract.appPath)
      .output(z.array(contract.deployment))
      .handler(async ({ context, input }) =>
        unwrap(await runtime.apps.history(context.principal, input.appId)),
      ),
    revoke: write
      .route({ method: "DELETE", path: "/apps/{appId}/creators/{userId}" })
      .input(contract.appPath.extend({ userId: z.string().min(1).max(128) }))
      .output(z.object({ revoked: z.boolean() }))
      .handler(async ({ context, input }) =>
        unwrap(await runtime.apps.revoke(context.principal, input.appId, input.userId)),
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
      .input(z.object({ accessRules: z.literal(1).optional() }).default({}))
      .output(contract.job.nullable())
      .handler(async ({ context, input }) =>
        unwrap(await runtime.jobs.claim(context.agent.id, input.accessRules === 1)),
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

  // Domain checks also reject user input as BAD_REQUEST. A distinct code lets
  // clients tell requests that do not match the API contract apart from them.
  const handler = new OpenAPIHandler(router, {
    clientInterceptors: [
      onError((error) => {
        if (
          error instanceof ORPCError &&
          error.code === "BAD_REQUEST" &&
          error.cause instanceof ValidationError
        )
          throw new ORPCError("INVALID_REQUEST", {
            status: 400,
            message: error.message,
            cause: error.cause,
          });
      }),
    ],
  });

  const generator = new OpenAPIGenerator({ schemaConverters: [new ZodToJsonSchemaConverter()] });

  const dispatch = async (request: Request) => {
    const url = new URL(request.url);

    const telemetry = /^\/api\/v1\/telemetry\/([^/]+)\/v1\/(logs|traces)$/.exec(url.pathname);

    if (telemetry && request.method === "POST")
      return runtime.telemetry.ingest(
        request,
        { appId: contract.identifier.parse(telemetry[1]) },
        z.enum(["logs", "traces"]).parse(telemetry[2]),
      );

    if (url.pathname === "/api/v1/openapi.json" && request.method === "GET") {
      principals.set(
        request,
        unwrap(await runtime.identity.authenticate(request, "platform:read")),
      );

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
                "CLI OAuth access token with platform:read, platform:write or network:manage scope. Network changes also require app ownership or administrator access. Agent endpoints require a separate agent token.",
            },
          },
        },
      });

      const paths = { ...document.paths };

      for (const [path, methods] of Object.entries(binaryPaths))
        paths[path] = { ...paths[path], ...methods };

      return Response.json({
        ...document,
        paths,
        components: {
          ...document.components,
          schemas: { ...document.components?.schemas, ...binarySchemas },
        },
      });
    }

    const icon = /^\/api\/v1\/apps\/([^/]+)\/icon$/.exec(url.pathname);

    if (icon && request.method === "GET") {
      const principal = unwrap(await runtime.identity.authenticate(request, "platform:read"));
      principals.set(request, principal);
      const appId = contract.identifier.parse(icon[1]);

      const result = unwrap(
        await readAppIcon(runtime.database.db, runtime.storage, principal, appId),
      );

      const cacheControl = iconCache(url.searchParams.get("deployment"), result.deploymentId);

      return result.icon
        ? iconResponse(result.icon, cacheControl)
        : missingIconResponse(cacheControl);
    }

    const screenshot = /^\/api\/v1\/apps\/([^/]+)\/screenshots\/([^/]+)$/.exec(url.pathname);

    if (screenshot && request.method === "GET") {
      const principal = unwrap(await runtime.identity.authenticate(request, "platform:read"));
      principals.set(request, principal);
      const appId = contract.identifier.parse(screenshot[1]);
      const number = contract.screenshotNumber.parse(Number(screenshot[2]));

      const result = unwrap(
        await readAppIcon(runtime.database.db, runtime.storage, principal, appId, (manifest) =>
          findAppScreenshot(manifest, number),
        ),
      );

      const cacheControl = iconCache(url.searchParams.get("deployment"), result.deploymentId);

      return result.icon
        ? iconResponse(result.icon, cacheControl)
        : missingIconResponse(cacheControl);
    }

    const templateIcon = /^\/api\/v1\/catalog\/templates\/([^/]+)\/icon$/.exec(url.pathname);

    if (templateIcon && request.method === "GET") {
      // The template catalog is the same for every organization.
      unwrap(await runtime.identity.authenticateUser(request, "platform:read"));
      const id = contract.templateId.parse(templateIcon[1]);

      // Templates change on GitHub without a version in the URL.
      return iconResponse(unwrap(await readTemplateIcon(id)), "private, max-age=3600");
    }

    const upload = /^\/api\/v1\/apps\/([^/]+)\/(worker|assets\/([^/]+)\/([^/]+))$/.exec(
      url.pathname,
    );

    if (upload && request.method === "PUT") {
      const principal = await authenticateWrite(request);
      const appId = contract.identifier.parse(upload[1]);

      if (upload[2] === "worker") {
        const key = idempotencyKey(request);

        const { metadata, documentation, modules } = unwrap(
          await parseWorkerUpload(request, contract.workerMetadata),
        );

        return Response.json(
          unwrap(
            await runtime.uploads.publish(principal, appId, metadata, documentation, modules, key),
          ),
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

      if (download[2] === "modules") {
        const bytes = unwrap(
          await runtime.jobs.module(
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

      const hash = contract.assetHash.parse(download[3]);
      const allowed = Object.values(artifact.manifest).some((entry) => entry.hash === hash);

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

    return response.matched
      ? response.response
      : Response.json({ code: "ROUTE_NOT_FOUND", message: "Not found" }, { status: 404 });
  };

  return async (request: Request) => {
    try {
      const response = await dispatch(request);

      // Responses are private and uncached unless a route chose a policy, as icons do.
      if (!response.headers.has("cache-control")) response.headers.set("cache-control", "no-store");

      return response;
    } catch (cause) {
      if (cause instanceof ORPCError) {
        if (cause.status >= 500 && cause.code !== "TELEMETRY_NOT_CONFIGURED")
          reportException(cause.cause instanceof Error ? cause.cause : cause, request);

        return Response.json(
          { code: z.string().parse(cause.code), message: cause.message },
          { status: cause.status },
        );
      }

      if (cause instanceof z.ZodError)
        return Response.json(
          { code: "INVALID_REQUEST", message: "Invalid request parameters" },
          { status: 400 },
        );
      console.error("Request failed", cause);

      if (cause instanceof Error) reportException(cause, request);

      return Response.json(
        { code: "INTERNAL_SERVER_ERROR", message: "The request could not be completed" },
        { status: 500 },
      );
    }
  };
};
