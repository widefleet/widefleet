import { createUserConnections, type UserConnectionRequest } from "./user-connections.ts";
import { createAppIdentityLinks, createAppUserIdentity } from "./app-user-identity.ts";
import { createAppSource } from "./app-source.ts";
import type { SourceBackend } from "./source-backend.ts";
import type { AuthenticationExtension } from "./runtime-extension.ts";
import { createConnectionService } from "./connections.ts";
import { createAppSecrets } from "./app-secrets.ts";
import type { SecretEncryption } from "./secret-encryption.ts";
import type { OrganizationAccess } from "./application-context.ts";
import type { BetterAuthOptions } from "better-auth";
import type { sveltekitCookies } from "better-auth/svelte-kit";
import type { Observation } from "./observation.ts";
import { runExtensionEffect } from "../extension-effects.ts";
import { createAuthentication } from "./auth.ts";
import { createIdentityService } from "./identity.ts";
import { createAppService } from "./apps.ts";
import { createAgentService } from "./agents.ts";
import { createRuntimeReleaseService, type BundledRuntime } from "./runtime-releases.ts";
import { createAppAccessService } from "./app-access.ts";
import { createNetworkService } from "./network.ts";
import { createWorkflowService } from "./workflows.ts";
import { createMigrationService } from "./migrations.ts";
import { createJobService } from "./jobs.ts";
import { createTemplateInstalls } from "./template-installs.ts";
import type { AppBuilder } from "./app-builder.ts";
import { createUploadService } from "./uploads.ts";
import { createBuildService } from "./builds.ts";
import type { BuildPolicy } from "./runtime-extension.ts";
import type { createCloudflareLogs } from "./cloudflare-logs.ts";
import { createTelemetry } from "./telemetry.ts";
import { createDirectory } from "./directory.ts";
import type { Configuration } from "./config.ts";
import type { createDatabase } from "./database.ts";
import type { createReporting } from "./reporting.ts";
import type { createSettingsService } from "./settings.ts";
import type { ArtifactStorage } from "./storage.ts";
import type { HostedExecution } from "./deployment-execution.ts";
import { createSignInEmail, type SendEmail } from "./email.ts";
import { createInvitationService } from "./members.ts";
import { createAuthenticationAdmission } from "./auth-admission.ts";
import { discoverPlatform } from "./platform-discovery.ts";
import { createCliLogin } from "./cli-login.ts";
import { createOnboardingService, type CreateOrganization } from "./onboarding.ts";
import { createDomainAccess } from "./domain-access.ts";
import { installationOrganizationId } from "../organization.ts";

export const createRuntime = ({
  configuration,
  database,
  settings,
  storage,
  reporting,
  observation,
  encryption,
  execution,
  hostedLogs,
  userConnectionRequest,
  organizationAccess: extensionOrganizationAccess,
  sendEmail,
  authRateLimit,
  authIpAddressHeaders,
  authValidateSchema,
  authCookies,
  createOrganization,
  authentication,
  source,
  discoveryTransport = "node",
  builder,
  builds,
  buildPolicy,
  bundledRuntime,
}: {
  configuration: Configuration & { BETTER_AUTH_SECRET: string };
  database: ReturnType<typeof createDatabase>;
  settings: ReturnType<typeof createSettingsService>;
  storage: ArtifactStorage;
  reporting: ReturnType<typeof createReporting>;
  observation?: Observation;
  encryption: SecretEncryption;
  execution?: HostedExecution;
  organizationAccess?: OrganizationAccess;
  sendEmail?: SendEmail;
  createOrganization?: CreateOrganization;
  authentication?: AuthenticationExtension;
  source?: SourceBackend;
  authRateLimit?: BetterAuthOptions["rateLimit"];
  authIpAddressHeaders?: string[];
  authValidateSchema?: boolean;
  authCookies?: ReturnType<typeof sveltekitCookies>;
  hostedLogs?: ReturnType<typeof createCloudflareLogs>;
  userConnectionRequest?: UserConnectionRequest;
  discoveryTransport?: "node" | "cloudflare";
  builder?: AppBuilder;
  /** Starts a recorded server build; installations without an app CI leave it out. */
  buildPolicy?: BuildPolicy;
  /** Starts the workflow of a build, and tells whether it ended. */
  builds?: { start: (id: string) => Promise<void>; ended: (id: string) => Promise<boolean> };
  bundledRuntime?: BundledRuntime;
}) => {
  const publicSignup = Boolean(createOrganization);

  const reportException = (...args: Parameters<NonNullable<Observation["exception"]>>) => {
    reporting.exception(args[0]);
    runExtensionEffect(() => observation?.exception?.(...args));
  };

  const organizationAccess =
    extensionOrganizationAccess ??
    (createOrganization
      ? ({
          filterOrganizations: async (candidates) => candidates.map(({ id }) => id),
        } satisfies OrganizationAccess)
      : undefined);

  const authOptions: NonNullable<Parameters<typeof createAuthentication>[2]> = {
    encryption,
    publicSignup,
    reportException,
    cliLoginSettings: settings,
  };

  if (observation) {
    authOptions.observation = observation;
    authOptions.appIdentityLinks = createAppIdentityLinks(database.db, configuration, settings);
  }

  if (authentication) authOptions.authentication = authentication;

  if (sendEmail) authOptions.sendEmail = sendEmail;

  if (authRateLimit) authOptions.rateLimit = authRateLimit;

  if (authIpAddressHeaders) authOptions.ipAddressHeaders = authIpAddressHeaders;

  if (authValidateSchema !== undefined) authOptions.validateSchema = authValidateSchema;

  if (authCookies) authOptions.cookies = authCookies;

  if (organizationAccess) authOptions.organizationAccess = organizationAccess;
  const auth = createAuthentication(configuration, database.db, authOptions);

  const apps = createAppService(
    database.db,
    configuration,
    execution,
    observation,
    Boolean(source),
  );

  const network = createNetworkService(database.db, execution);

  const uploads = createUploadService(database.db, storage, configuration, execution, source);

  const appSecrets = createAppSecrets(database.db, encryption, execution);

  const runtime = {
    auth,
    userConnections: createUserConnections(
      database.db,
      configuration,
      createAppUserIdentity(database.db, configuration, settings),
      userConnectionRequest,
      reportException,
    ),
    publicSignup,
    onboarding: createOnboardingService(database.db, settings, createOrganization, observation),
    domainAccess: createDomainAccess(
      database.db,
      organizationAccess ?? {
        filterOrganizations: async () => [installationOrganizationId],
      },
      publicSignup,
    ),
    identity: createIdentityService(
      auth,
      database.db,
      configuration,
      organizationAccess,
      authentication?.allowUser,
      encryption,
    ),
    directory: createDirectory(
      async (organizationId) => (await settings.resolve(organizationId)).identity,
    ),
    configuration,
    database,
    settings,
    reporting: {
      ...reporting,
      exception: reportException,
    },
    storage,
    invitations: createInvitationService(database.db, configuration, sendEmail, organizationAccess),
    emailSignIn: Boolean(createSignInEmail(configuration, sendEmail)),
    signInProvider: createAuthenticationAdmission(
      database.db,
      organizationAccess,
      false,
      configuration,
    ).signInProvider,
    discoverPlatform: (domain: string) => discoverPlatform(domain, discoveryTransport),
    cliLogin: createCliLogin(database.db, configuration),
    source: createAppSource(database.db, source),
    apps,
    agents: createAgentService(database.db),
    jobs: createJobService(
      database.db,
      storage,
      encryption,
      reporting.operation,
      configuration.APP_HTTPS_PORT,
      source,
      bundledRuntime,
    ),
    network,
    appAccess: createAppAccessService(database.db, execution),
    workflows: createWorkflowService(database.db, execution),
    migrations: createMigrationService(database.db, storage, execution),
    connections: createConnectionService(database.db, storage, execution),
    appSecrets,
    releases: createRuntimeReleaseService(database.db, storage, execution),
    uploads,
    builds: createBuildService(database.db, source, builds, buildPolicy),
    templates: createTemplateInstalls(configuration, apps, uploads, network, appSecrets, builder),
    telemetry: createTelemetry(database.db, storage, configuration, hostedLogs),
  };

  return async () => {
    await auth.$context;

    return runtime;
  };
};

export type Runtime = Awaited<ReturnType<ReturnType<typeof createRuntime>>>;

export const createRequestRuntime = (resolve: () => Promise<Runtime>) => {
  let pending: Promise<Runtime> | undefined;

  return () => (pending ??= resolve());
};
