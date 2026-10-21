import {
  installationSettings,
  settingsInput,
  settingsUpdate,
  setupOwner,
} from "@platform/contracts";
import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import type { OrganizationCredential } from "./organization-operations.ts";
import { appCallbackUrl, type AppSignIn } from "./app-sign-in.ts";
import { companyIdentity } from "./company-identity.ts";
import { companyLoginRevision, type Authentication } from "./auth.ts";
import type { Configuration } from "./config.ts";
import type { Database, DatabaseExecutor } from "./database.ts";
import type { Principal } from "./identity.ts";
import { InvalidOperation } from "./errors.ts";
import { decryptSecret, encryptSecret } from "./secret-encryption.ts";
import { installationOrganizationId } from "../organization.ts";
import {
  installationId,
  readInstallation,
  readOrganizationSettings,
  createInstallationOwner,
} from "./installation-store.ts";
import { session, oauthRefreshToken } from "./auth-schema.ts";
import { oauthClient } from "./auth-schema.ts";
import { readSsoConfiguration, ssoRuntimeIdentity, saveSsoProvider } from "./sso-settings.ts";
import { appLoginClientId, readAppLogin, registerAppLogin } from "./app-login-client.ts";
import { installation, organizationSettings } from "./schema.ts";

const requireAdmin = (principal: Principal, organizationId: string) => {
  if (!principal.application.admin || principal.application.organizationId !== organizationId)
    throw new InvalidOperation({
      code: "FORBIDDEN",
      message: "Organization administrator access is required",
    });
};

const createOrganizationSettingsService = (
  configuration: Configuration,
  database: Database,
  encryptionKey: string,
  appSignIn: AppSignIn | null,
  organizationId: string,
  revision: { value: number },
  emailSignIn: boolean,
) => {
  const lockSettings = async (transaction: DatabaseExecutor) => {
    await transaction
      .insert(organizationSettings)
      .values({
        organizationId,
        settings: installationSettings.parse({}),
      })
      .onConflictDoNothing();
    await transaction
      .select({ organizationId: organizationSettings.organizationId })
      .from(organizationSettings)
      .where(eq(organizationSettings.organizationId, organizationId))
      .for("update");
  };

  const readCurrent = async (transaction: DatabaseExecutor) => {
    const [stored] = await transaction
      .select({ directorySecret: organizationSettings.directorySecret })
      .from(organizationSettings)
      .where(eq(organizationSettings.organizationId, organizationId));

    const state = {
      ...(await readInstallation(transaction)),
      settings: await readOrganizationSettings(transaction, organizationId),
    };

    const errors: string[] = [];
    const sso = await readSsoConfiguration(transaction, encryptionKey, organizationId);
    let identity: z.infer<typeof companyIdentity> | null = null;

    try {
      if (sso?.domainVerified && sso.required) {
        identity = ssoRuntimeIdentity(sso);

        if (state.settings.directory)
          identity.directory = {
            clientId: state.settings.directory.clientId,
            clientSecret: await decryptSecret(encryptionKey, stored?.directorySecret ?? ""),
          };
      }
    } catch (cause) {
      errors.push(
        cause instanceof InvalidOperation ? cause.message : "Company sign-in could not be prepared",
      );
    }

    return { state, identity, sso, errors };
  };

  const resolve = async () => {
    // A write overlapping this snapshot must invalidate it, even if it finishes first.
    const startedRevision = revision.value;

    const current = await database.transaction(readCurrent, {
      isolationLevel: "repeatable read",
      accessMode: "read only",
    });

    return { ...current, revision: startedRevision };
  };

  const inspect = async (publish = false) => {
    const resolved = await database.transaction(
      async (transaction) => {
        // Keep publication ordered across hosted requests and self-hosted processes.
        // Ordinary readers use MVCC and do not wait for this writer's row lock.
        if (publish) await lockSettings(transaction);
        const current = await readCurrent(transaction);

        let fallback =
          !current.identity && emailSignIn
            ? await readAppLogin(transaction, configuration, encryptionKey, organizationId)
            : null;

        if (publish && emailSignIn && !current.identity) {
          await registerAppLogin(transaction, configuration, encryptionKey, organizationId);
          fallback = await readAppLogin(transaction, configuration, encryptionKey, organizationId);
        }

        if (publish && current.identity)
          await transaction
            .update(oauthClient)
            .set({ disabled: true })
            .where(eq(oauthClient.clientId, appLoginClientId(organizationId)));
        const identity = current.identity ?? fallback;

        let expectedRevision = "";

        if (identity && appSignIn) {
          try {
            const secret = identity.management.clientSecret;
            expectedRevision = await appSignIn.revision(identity, secret);

            if (publish) await appSignIn.publish(identity, secret);
          } catch (cause) {
            current.errors.push(
              cause instanceof InvalidOperation
                ? cause.message
                : "App sign-in could not be prepared",
            );
          }
        }

        return { ...current, revision: expectedRevision };
      },
      {
        isolationLevel: publish ? "read committed" : "repeatable read",
        accessMode: publish ? "read write" : "read only",
      },
    );

    const current =
      appSignIn && resolved.revision
        ? await appSignIn.status(resolved.revision)
        : {
            revision: "",
            state: "waiting" as const,
            message:
              resolved.sso && !resolved.sso.domainVerified
                ? "Verify the company domain before publishing its app sign-in configuration."
                : "App sign-in has no publishable configuration.",
          };

    const activation =
      resolved.revision && current.revision !== resolved.revision
        ? {
            revision: resolved.revision,
            state: "applying" as const,
            message: "The sign-in service is applying the configuration",
          }
        : current;

    const connection = resolved.sso;

    const sso = connection
      ? {
          providerId: connection.providerId,
          appIdentityType: connection.appIdentityType,
          issuer: connection.issuer,
          domain: connection.domain,
          domainVerified: connection.domainVerified,
          oidcConfig: {
            clientId: connection.oidcConfig.clientId,
            pkce: connection.oidcConfig.pkce,
            scopes: connection.oidcConfig.scopes,
            mapping: connection.oidcConfig.mapping,
          },
        }
      : null;

    return {
      settings: resolved.state.settings,
      sso,
      ssoRequired: Boolean(connection?.domainVerified && connection.required),
      localPasswordEnabled:
        organizationId === installationOrganizationId && resolved.state.localPasswordEnabled,
      managementCallbackUrl: sso
        ? `${configuration.PLATFORM_URL}/api/auth/sso/callback/${sso.providerId}`
        : null,
      appCallbackUrl: appSignIn?.callbackUrl ?? appCallbackUrl(configuration, organizationId),
      activation,
      error: resolved.errors.length ? resolved.errors.join(". ") : null,
    };
  };

  const prepare = async (input: z.infer<typeof settingsInput>) => {
    const next = settingsInput.parse(input);

    const state = {
      ...(await readInstallation(database)),
      settings: await readOrganizationSettings(database, organizationId),
    };

    const connection = await readSsoConfiguration(database, encryptionKey, organizationId);

    if (
      !emailSignIn &&
      (!state.localPasswordEnabled ||
        connection ||
        organizationId !== installationOrganizationId) &&
      !next.sso
    )
      throw new InvalidOperation({
        code: "BAD_REQUEST",
        message: "Configure a replacement company login before removing the active provider",
      });

    if (next.directory && !next.directory.clientSecret) {
      const [saved] = await database
        .select({ secret: organizationSettings.directorySecret })
        .from(organizationSettings)
        .where(eq(organizationSettings.organizationId, organizationId));

      if (!saved?.secret)
        throw new InvalidOperation({
          code: "BAD_REQUEST",
          message: "Enter the directory client secret",
        });
    }

    if (next.directory && next.sso?.appIdentityType !== "entra")
      throw new InvalidOperation({
        code: "BAD_REQUEST",
        message: "Microsoft Graph directory search requires Entra app identity",
      });

    return appSignIn
      ? appSignIn.plan(null)
      : {
          restartRequired: false,
          message:
            "Management sign-in will be updated. App sign-in is not connected to this installation.",
        };
  };

  const save = async (
    input: z.infer<typeof settingsInput>,
    credential?: OrganizationCredential,
  ) => {
    const next = settingsInput.parse(input);

    if (credential) await saveSsoProvider(database, organizationId, next.sso, credential);
    else if (next.sso)
      throw new InvalidOperation({
        code: "FORBIDDEN",
        message: "Sign in before configuring the SSO provider",
      });
    await database.transaction(async (transaction) => {
      await lockSettings(transaction);

      const [current] = await transaction
        .select({ directorySecret: organizationSettings.directorySecret })
        .from(organizationSettings)
        .where(eq(organizationSettings.organizationId, organizationId));

      const directorySecret = !next.directory
        ? null
        : next.directory.clientSecret
          ? await encryptSecret(encryptionKey, next.directory.clientSecret)
          : current?.directorySecret;

      if (next.directory && !directorySecret)
        throw new InvalidOperation({
          code: "BAD_REQUEST",
          message: "Enter the directory client secret",
        });
      const directory = next.directory ? { clientId: next.directory.clientId } : null;

      await transaction
        .update(organizationSettings)
        .set({
          directorySecret: directorySecret ?? null,
          ssoRequired: next.sso ? undefined : false,
          settings: installationSettings.parse({
            directory,
            externallyManaged: next.externallyManaged,
          }),
        })
        .where(eq(organizationSettings.organizationId, organizationId));
    });

    revision.value++;

    return inspect(true);
  };

  return {
    get revision() {
      return revision.value;
    },
    resolve,
    inspect,
    initialize: async (
      input: z.infer<typeof settingsInput>,
      credential?: OrganizationCredential,
    ) => {
      await prepare(input);

      return save(input, credential);
    },
    read: async (principal: Principal) => {
      requireAdmin(principal, organizationId);

      return inspect();
    },
    plan: async (principal: Principal, input: z.infer<typeof settingsInput>) => {
      requireAdmin(principal, organizationId);

      return prepare(input);
    },
    update: async (
      principal: Principal,
      input: z.infer<typeof settingsUpdate>,
      browser: boolean,
      credential: OrganizationCredential,
    ) => {
      requireAdmin(principal, organizationId);

      const state = {
        ...(await readInstallation(database)),
        settings: await readOrganizationSettings(database, organizationId),
      };

      if (browser && state.settings.externallyManaged)
        throw new InvalidOperation({
          code: "FORBIDDEN",
          message:
            "Configuration is externally managed. Turn off external management to edit it in the UI.",
        });
      const { acknowledgeRestart, ...next } = settingsUpdate.parse(input);
      const plan = await prepare(next);

      if (plan.restartRequired && !acknowledgeRestart)
        throw new InvalidOperation({ code: "CONFLICT", message: plan.message });

      return save(next, credential);
    },
    setExternalManagement: async (principal: Principal, enabled: boolean) => {
      requireAdmin(principal, organizationId);
      await database.transaction(async (transaction) => {
        await lockSettings(transaction);
        await transaction
          .update(organizationSettings)
          .set({
            settings: sql`jsonb_set(${organizationSettings.settings}, '{externallyManaged}', to_jsonb(${enabled}::boolean))`,
          })
          .where(eq(organizationSettings.organizationId, organizationId));
      });

      revision.value++;

      return inspect();
    },
    domainVerification: async (principal: Principal, auth: Authentication, headers: Headers) => {
      requireAdmin(principal, organizationId);
      const provider = await readSsoConfiguration(database, encryptionKey, organizationId);

      if (!provider)
        throw new InvalidOperation({
          code: "BAD_REQUEST",
          message: "Save the company SSO configuration first",
        });

      const proof = await auth.api.requestDomainVerification({
        headers,
        body: { providerId: provider.providerId },
      });

      return {
        name: `_better-auth-token-${provider.providerId}.${provider.domain}`,
        type: "TXT" as const,
        value: proof.domainVerificationToken,
      };
    },
    verifyDomain: async (principal: Principal, auth: Authentication, headers: Headers) => {
      requireAdmin(principal, organizationId);
      const provider = await readSsoConfiguration(database, encryptionKey, organizationId);

      if (!provider)
        throw new InvalidOperation({
          code: "BAD_REQUEST",
          message: "Save the company SSO configuration first",
        });
      await auth.api.verifyDomain({ headers, body: { providerId: provider.providerId } });
      revision.value++;

      if (provider.required) await inspect(true);

      return { success: true };
    },
    activateSso: async (principal: Principal) => {
      requireAdmin(principal, organizationId);
      await database.transaction(async (transaction) => {
        await lockSettings(transaction);
        const provider = await readSsoConfiguration(transaction, encryptionKey, organizationId);

        if (!provider?.domainVerified)
          throw new InvalidOperation({
            code: "CONFLICT",
            message: "Verify the company domain before activating SSO",
          });
        await transaction
          .update(organizationSettings)
          .set({ ssoRequired: true })
          .where(eq(organizationSettings.organizationId, organizationId));
      });
      revision.value++;

      return inspect(true);
    },
    complete: async (principal: Principal, auth: Authentication, headers: Headers) => {
      requireAdmin(principal, organizationId);

      if (!principal.admin || organizationId !== installationOrganizationId)
        throw new InvalidOperation({
          code: "FORBIDDEN",
          message: "Only the installation administrator can finish installation setup",
        });
      const current = await auth.api.getSession({ headers });
      const resolved = await resolve();
      const state = resolved.state;
      const proof = companyLoginRevision(resolved.sso);

      if (
        !proof ||
        !resolved.sso?.domainVerified ||
        current?.session.companyConfiguration !== proof
      )
        throw new InvalidOperation({
          code: "CONFLICT",
          message: "Sign in with the linked company account to confirm administrator access first",
        });
      await database.transaction(async (transaction) => {
        await transaction
          .update(organizationSettings)
          .set({ ssoRequired: true })
          .where(eq(organizationSettings.organizationId, organizationId));
        await transaction
          .update(installation)
          .set({ localPasswordEnabled: false })
          .where(eq(installation.id, installationId));

        const localSessions = transaction
          .select({ id: session.id })
          .from(session)
          .where(
            and(eq(session.companyConfiguration, ""), eq(session.userId, state.ownerId ?? "")),
          );

        await transaction
          .delete(oauthRefreshToken)
          .where(inArray(oauthRefreshToken.sessionId, localSessions));
        await transaction
          .delete(session)
          .where(
            and(eq(session.companyConfiguration, ""), eq(session.userId, state.ownerId ?? "")),
          );
      });

      revision.value++;

      return inspect(true);
    },
  };
};

export const createSettingsService = (
  configuration: Configuration,
  database: Database,
  encryptionKey: string,
  appSignIn: (organizationId: string) => AppSignIn | null,
  emailSignIn = false,
) => {
  const revision = { value: 0 };

  const scoped = (organizationId: string) =>
    createOrganizationSettingsService(
      configuration,
      database,
      encryptionKey,
      appSignIn(organizationId),
      organizationId,
      revision,
      emailSignIn,
    );

  const installed = scoped(installationOrganizationId);

  return {
    get revision() {
      return revision.value;
    },
    resolve: (organizationId = installationOrganizationId) => scoped(organizationId).resolve(),

    inspect: installed.inspect,
    createOwner: async (input: z.infer<typeof setupOwner>, bootstrapPending = false) => {
      const owner = await createInstallationOwner(database, input, bootstrapPending);

      if (emailSignIn) await installed.inspect(true);

      return owner;
    },
    publish: (organizationId = installationOrganizationId) => scoped(organizationId).inspect(true),
    initialize: (
      input: z.infer<typeof settingsInput>,
      organizationId = installationOrganizationId,
      credential?: OrganizationCredential,
    ) => scoped(organizationId).initialize(input, credential),
    read: (principal: Principal) => scoped(principal.application.organizationId).read(principal),
    plan: (principal: Principal, input: z.infer<typeof settingsInput>) =>
      scoped(principal.application.organizationId).plan(principal, input),
    update: (
      principal: Principal,
      input: z.infer<typeof settingsUpdate>,
      browser: boolean,
      credential: OrganizationCredential,
    ) => scoped(principal.application.organizationId).update(principal, input, browser, credential),
    setExternalManagement: (principal: Principal, enabled: boolean) =>
      scoped(principal.application.organizationId).setExternalManagement(principal, enabled),
    domainVerification: (principal: Principal, auth: Authentication, headers: Headers) =>
      scoped(principal.application.organizationId).domainVerification(principal, auth, headers),
    verifyDomain: (principal: Principal, auth: Authentication, headers: Headers) =>
      scoped(principal.application.organizationId).verifyDomain(principal, auth, headers),
    activateSso: (principal: Principal) =>
      scoped(principal.application.organizationId).activateSso(principal),
    complete: (principal: Principal, auth: Authentication, headers: Headers) =>
      scoped(principal.application.organizationId).complete(principal, auth, headers),
  };
};
