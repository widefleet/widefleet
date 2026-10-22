import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { DEVICE_CODE_GRANT_TYPE } from "@better-auth/oauth-provider";
import { APIError } from "better-auth/api";
import type { JSONWebKeySet } from "jose";
import { installationOrganizationId } from "../organization.ts";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { eq, sql } from "drizzle-orm";
import {
  apiResource,
  authenticationOptions,
  cliClientId,
  cliResourcePolicy,
  cliScopes,
} from "./auth-options.ts";
import * as authSchema from "./auth-schema.ts";
import type { Configuration } from "./config.ts";
import type { Database, DatabaseExecutor } from "./database.ts";
import { readSsoConfiguration } from "./sso-settings.ts";
import { createAuthenticationAdmission } from "./auth-admission.ts";
import type { OrganizationAccess } from "./application-context.ts";
import { companySsoOrigins, companySsoPlugin } from "./company-sso.ts";
import { pluginAuthentication, managedPluginPaths } from "./plugin-authentication.ts";

export const companyLoginRevision = (
  connection: Awaited<ReturnType<typeof readSsoConfiguration>>,
) =>
  connection
    ? createHash("sha256")
        .update(
          JSON.stringify({
            providerId: connection.providerId,
            issuer: connection.issuer,
            oidcConfig: connection.oidcConfig,
          }),
        )
        .digest("hex")
    : "";

export const createAuthentication = (
  configuration: Configuration,
  database: DatabaseExecutor,
  options: Parameters<typeof authenticationOptions>[1] & {
    organizationAccess?: OrganizationAccess;
    encryptionKey?: string;
  } = {},
) => {
  const settings = authenticationOptions(configuration, {
    ...createAuthenticationAdmission(database, options.organizationAccess),
    ...options,
  });

  const encryptionKey =
    options.encryptionKey ??
    configuration.PLATFORM_ENCRYPTION_KEY ??
    configuration.BETTER_AUTH_SECRET;

  if (!encryptionKey) throw new Error("An encryption key is required for authentication");

  let readKeys: () => Promise<JSONWebKeySet> = async () => {
    throw new Error("Authentication is initializing");
  };

  const authorizePlugin = pluginAuthentication(
    database,
    configuration,
    encryptionKey,
    () => readKeys(),
    options.organizationAccess,
  );

  const auth = betterAuth({
    ...settings,
    disabledPaths: [...settings.disabledPaths, ...managedPluginPaths],
    trustedOrigins: (request) =>
      companySsoOrigins(database, configuration.PLATFORM_URL, encryptionKey, request),
    plugins: [
      ...settings.plugins,
      companySsoPlugin(database, encryptionKey, options.organizationAccess),
      {
        id: "management-credentials",
        // These library endpoints are invoked by the shared services. Exposing
        // them directly would skip the shared UI/API entrypoints.
        onRequest: async (request) => {
          const path = new URL(request.url).pathname;

          if (
            path.startsWith("/api/auth/organization/") ||
            (path.startsWith("/api/auth/sso/") && !path.startsWith("/api/auth/sso/callback/"))
          )
            return { response: new Response("Not Found", { status: 404 }) };

          return undefined;
        },
        hooks: {
          before: [
            {
              matcher: (context) => managedPluginPaths.includes(context.path ?? ""),
              handler: authorizePlugin,
            },
          ],
        },
      },
    ],
    database: drizzleAdapter(database, { provider: "pg", schema: authSchema, transaction: true }),
    databaseHooks: {
      session: {
        update: {
          before: async (record, context) => {
            const current = context?.context.session?.session;

            // Keep recovery's original deadline while normal sessions renew.
            return {
              data:
                current?.["recovery"] === true && record.expiresAt
                  ? { ...record, expiresAt: current.expiresAt }
                  : record,
            };
          },
        },
        create: {
          before: async (record, context) => {
            const providerId = context?.path.startsWith("/sso/callback/")
              ? context.params?.["providerId"]
              : undefined;

            const [provider] = providerId
              ? await database
                  .select()
                  .from(authSchema.ssoProvider)
                  .where(eq(authSchema.ssoProvider.providerId, providerId))
              : [];

            if (providerId && !provider?.domainVerified)
              throw new APIError("FORBIDDEN", { message: "Company SSO is not verified" });
            let revision = "";

            if (provider && context) {
              const subject = await context.context.internalAdapter.findUserById(record.userId);

              // Domain ownership proves matching addresses, not external guests' email.
              if (
                subject &&
                !subject.emailVerified &&
                subject.email.toLowerCase().split("@")[1] === provider.domain
              )
                await context.context.internalAdapter.updateUser(record.userId, {
                  emailVerified: true,
                });

              revision = companyLoginRevision(
                await readSsoConfiguration(database, encryptionKey, provider.organizationId),
              );
            }

            return {
              data: {
                ...record,
                identityOrganizationId:
                  provider?.organizationId ??
                  (record["recovery"] === true ? installationOrganizationId : null),
                companyConfiguration: revision,
              },
            };
          },
        },
      },
    },
  });

  readKeys = () => auth.api.getJwks();

  return auth;
};

export type Authentication = ReturnType<typeof createAuthentication>;

export const registerCli = async (database: Database, configuration: Configuration) =>
  database.transaction(async (transaction) => {
    await transaction.execute(sql`select pg_advisory_xact_lock(1740031201)`);

    const auth = createAuthentication(configuration, transaction, { initializeResources: true });
    await auth.$context;

    const policy = cliResourcePolicy(configuration);

    const [resource] = await transaction
      .select()
      .from(authSchema.oauthResource)
      .where(eq(authSchema.oauthResource.identifier, policy.identifier));

    // Plugin initialization can defer seeding. Verify persisted policy before
    // committing the client registration or reporting successful initialization.
    if (
      !resource ||
      resource.name !== policy.identifier ||
      resource.accessTokenTtl !== policy.accessTokenTtl ||
      !isDeepStrictEqual(resource.allowedScopes, policy.allowedScopes) ||
      resource.refreshTokenTtl !== null ||
      resource.signingAlgorithm !== null ||
      resource.signingKeyId !== null ||
      resource.customClaims !== null ||
      resource.dpopBoundAccessTokensRequired !== false ||
      resource.disabled !== false
    )
      throw new Error("CLI resource policy was not initialized; retry installation initialization");

    const [client] = await transaction
      .select({ id: authSchema.oauthClient.id })
      .from(authSchema.oauthClient)
      .where(eq(authSchema.oauthClient.clientId, cliClientId));

    if (!client) {
      // Installation-owned public client: no user session or client secret exists at bootstrap.
      await transaction.insert(authSchema.oauthClient).values({
        id: crypto.randomUUID(),
        clientId: cliClientId,
        name: "Widefleet CLI",
        applicationType: "native",
        tokenEndpointAuthMethod: "none",
        grantTypes: [DEVICE_CODE_GRANT_TYPE, "refresh_token"],
        scopes: cliScopes,
        redirectUris: [],
        responseTypes: [],
        skipConsent: false,
        disabled: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
    } else {
      await transaction
        .update(authSchema.oauthClient)
        .set({ name: "Widefleet CLI", scopes: cliScopes, updatedAt: new Date() })
        .where(eq(authSchema.oauthClient.clientId, cliClientId));
    }

    await transaction
      .insert(authSchema.oauthClientResource)
      .values({
        id: crypto.randomUUID(),
        clientId: cliClientId,
        resourceId: apiResource(configuration),
        createdAt: new Date(),
      })
      .onConflictDoNothing();
  });
