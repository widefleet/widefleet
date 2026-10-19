import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { DEVICE_CODE_GRANT_TYPE } from "@better-auth/oauth-provider";
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
import { enrollCompanyUser } from "./organization.ts";
import { companyAccountProvider } from "./company-identity.ts";

export const companyLoginRevision = (configuration: Configuration) =>
  configuration.IDENTITY
    ? createHash("sha256")
        .update(
          JSON.stringify({
            provider: configuration.IDENTITY.provider,
            management: configuration.IDENTITY.management,
          }),
        )
        .digest("hex")
    : "";

export const createAuthentication = (
  configuration: Configuration,
  database: DatabaseExecutor,
  options: Parameters<typeof authenticationOptions>[1] = {},
) =>
  betterAuth({
    ...authenticationOptions(configuration, options),
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
          before: async (record, context) => ({
            data: {
              ...record,
              companyConfiguration:
                configuration.IDENTITY &&
                context?.path.startsWith("/callback/") &&
                context.params?.["id"] === companyAccountProvider(configuration.IDENTITY)
                  ? companyLoginRevision(configuration)
                  : "",
            },
          }),
        },
      },
      account: {
        create: {
          after: async (identity) => {
            if (
              configuration.IDENTITY &&
              identity.providerId === companyAccountProvider(configuration.IDENTITY)
            )
              await enrollCompanyUser(database, identity.userId);
          },
        },
      },
    },
  });

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
