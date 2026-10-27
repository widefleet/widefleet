import type { OrganizationAccess } from "./application-context.ts";
import type { BetterAuthOptions } from "better-auth";
import type { sveltekitCookies } from "better-auth/svelte-kit";
import type { Observation } from "./observation.ts";
import { runExtensionEffect } from "../extension-effects.ts";
import { createAuthentication } from "./auth.ts";
import { createIdentityService } from "./identity.ts";
import { createAppService } from "./apps.ts";
import { createAgentService } from "./agents.ts";
import { createRuntimeReleaseService } from "./runtime-releases.ts";
import { createConnectorService } from "./connectors.ts";
import { createAppAccessService } from "./app-access.ts";
import { createNetworkService } from "./network.ts";
import { createWorkflowService } from "./workflows.ts";
import { createMigrationService } from "./migrations.ts";
import { createJobService } from "./jobs.ts";
import { createUploadService } from "./uploads.ts";
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

export const createRuntime = ({
  configuration,
  database,
  settings,
  storage,
  reporting,
  observation,
  encryptionKey,
  execution,
  hostedLogs,
  organizationAccess,
  sendEmail,
  authRateLimit,
  authIpAddressHeaders,
  authCookies,
  discoveryTransport = "node",
}: {
  configuration: Configuration & { BETTER_AUTH_SECRET: string };
  database: ReturnType<typeof createDatabase>;
  settings: ReturnType<typeof createSettingsService>;
  storage: ArtifactStorage;
  reporting: ReturnType<typeof createReporting>;
  observation?: Observation;
  encryptionKey: string;
  execution?: HostedExecution;
  organizationAccess?: OrganizationAccess;
  sendEmail?: SendEmail;
  authRateLimit?: BetterAuthOptions["rateLimit"];
  authIpAddressHeaders?: string[];
  authCookies?: ReturnType<typeof sveltekitCookies>;
  hostedLogs?: ReturnType<typeof createCloudflareLogs>;
  discoveryTransport?: "node" | "cloudflare";
}) => {
  const authOptions: NonNullable<Parameters<typeof createAuthentication>[2]> = { encryptionKey };

  if (observation) authOptions.observation = observation;

  if (sendEmail) authOptions.sendEmail = sendEmail;

  if (authRateLimit) authOptions.rateLimit = authRateLimit;

  if (authIpAddressHeaders) authOptions.ipAddressHeaders = authIpAddressHeaders;

  if (authCookies) authOptions.cookies = authCookies;

  if (organizationAccess) authOptions.organizationAccess = organizationAccess;
  const auth = createAuthentication(configuration, database.db, authOptions);

  const runtime = {
    auth,
    identity: createIdentityService(auth, database.db, configuration, organizationAccess),
    directory: createDirectory(
      async (organizationId) => (await settings.resolve(organizationId)).identity,
    ),
    configuration,
    database,
    settings,
    reporting: {
      ...reporting,
      exception: (error: Error) => {
        reporting.exception(error);

        runExtensionEffect(() => observation?.exception?.(error));
      },
    },
    storage,
    invitations: createInvitationService(database.db, configuration, sendEmail, organizationAccess),
    emailSignIn: Boolean(createSignInEmail(configuration, sendEmail)),
    signInProvider: createAuthenticationAdmission(database.db, organizationAccess).signInProvider,
    discoverPlatform: (domain: string) => discoverPlatform(domain, discoveryTransport),
    cliLogin: createCliLogin(database.db, configuration),
    apps: createAppService(database.db, configuration, execution, observation),
    agents: createAgentService(database.db),
    jobs: createJobService(database.db, storage, encryptionKey, reporting.operation),
    network: createNetworkService(database.db, execution),
    appAccess: createAppAccessService(database.db, execution),
    workflows: createWorkflowService(database.db, execution),
    migrations: createMigrationService(database.db, storage, execution),
    connectors: createConnectorService(database.db, storage, encryptionKey, execution),
    releases: createRuntimeReleaseService(database.db, storage, execution),
    uploads: createUploadService(database.db, storage, configuration, execution),
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
