import {
  identitySettings,
  installationSettings,
  settingsInput,
  settingsUpdate,
  setupOwner,
} from "@platform/contracts";
import { and, eq, inArray, notInArray, sql } from "drizzle-orm";
import { z } from "zod";
import type { OrganizationCredential } from "./organization-operations.ts";
import { appCallbackUrl, type AppSignIn } from "./app-sign-in.ts";
import { companyAccountProvider, companyIdentity } from "./company-identity.ts";
import { companyLoginRevision, type Authentication } from "./auth.ts";
import type { Configuration } from "./config.ts";
import type { Database, DatabaseExecutor } from "./database.ts";
import type { Principal } from "./identity.ts";
import { InvalidOperation } from "./errors.ts";
import { createOrganizationSecrets } from "./organization-secrets.ts";
import { installationOrganizationId } from "../organization.ts";
import {
  installationId,
  readInstallation,
  readOrganizationSettings,
  createInstallationOwner,
} from "./installation-store.ts";
import { session, oauthRefreshToken } from "./auth-schema.ts";
import { prepareSsoConfiguration, readSsoProvider, saveSsoProvider } from "./sso-settings.ts";
import { installation, organizationSecrets, organizationSettings } from "./schema.ts";

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
  const secrets = createOrganizationSecrets(database, encryptionKey, organizationId);

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
    const snapshotSecrets = createOrganizationSecrets(transaction, encryptionKey, organizationId);

    const state = {
      ...(await readInstallation(transaction)),
      settings: await readOrganizationSettings(transaction, organizationId),
    };

    const identity = state.settings.identity;
    const sso = await readSsoProvider(transaction, organizationId);

    if (!identity) return { state, identity: null, sso, errors: [] };

    let resolved: z.infer<typeof companyIdentity> | null = null;
    const errors: string[] = [];

    try {
      resolved = companyIdentity.parse({
        provider: identity.provider,
        management: {
          clientId: identity.management.clientId,
          clientSecret: await snapshotSecrets.resolve(identity.management.secret),
        },
      });
    } catch (cause) {
      errors.push(
        cause instanceof InvalidOperation
          ? cause.message
          : "Management sign-in could not be prepared",
      );
    }

    if (identity.directory && resolved) {
      try {
        resolved.directory = {
          clientId: identity.directory.clientId,
          clientSecret: await snapshotSecrets.resolve(identity.directory.secret),
        };
      } catch (cause) {
        errors.push(
          cause instanceof InvalidOperation
            ? cause.message
            : "The group directory could not be prepared",
        );
      }
    }

    return { state, identity: sso?.domainVerified ? resolved : null, sso, errors };
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

        const identity = current.sso?.domainVerified ? current.state.settings.identity : null;

        let expectedRevision = "";

        if (identity && appSignIn) {
          try {
            const secret = await createOrganizationSecrets(
              transaction,
              encryptionKey,
              organizationId,
            ).resolve(identity.apps.secret);

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

    const current = appSignIn
      ? await appSignIn.status(resolved.revision)
      : {
          revision: "",
          state: "waiting" as const,
          message: "App sign-in is not connected to this installation.",
        };

    const activation =
      resolved.revision && current.revision !== resolved.revision
        ? {
            revision: resolved.revision,
            state: "applying" as const,
            message: "The sign-in service is applying the configuration",
          }
        : current;

    const identity = resolved.state.settings.identity;

    return {
      settings: resolved.state.settings,
      sso: resolved.sso
        ? {
            providerId: resolved.sso.providerId,
            domain: resolved.sso.domain,
            verified: resolved.sso.domainVerified,
          }
        : null,
      localPasswordEnabled:
        organizationId === installationOrganizationId && resolved.state.localPasswordEnabled,
      managementCallbackUrl: identity
        ? `${configuration.PLATFORM_URL}/api/auth/sso/callback/${companyAccountProvider(identity, organizationId)}`
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

    if (
      !emailSignIn &&
      (!state.localPasswordEnabled ||
        state.settings.identity ||
        organizationId !== installationOrganizationId) &&
      !next.identity
    )
      throw new InvalidOperation({
        code: "BAD_REQUEST",
        message: "Configure a replacement company login before removing the active provider",
      });

    if (next.identity) {
      await secrets.resolve(next.identity.management.secret);
      await secrets.resolve(next.identity.apps.secret);

      if (next.identity.directory) await secrets.resolve(next.identity.directory.secret);
    }

    return appSignIn
      ? appSignIn.plan(next.identity)
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
    const discovered = next.identity ? await prepareSsoConfiguration(next.identity) : null;
    await database.transaction(async (transaction) => {
      // Keep replacing references and removing unused secret rows in one ordered transaction.
      await lockSettings(transaction);
      const identity = next.identity;

      // Copy shared references before replacing the provider's credential.
      const apps = identity
        ? {
            clientId: identity.apps.clientId,
            secret: await secrets.save(transaction, identity.apps.secret),
          }
        : null;

      const directory = identity?.directory
        ? {
            clientId: identity.directory.clientId,
            secret: await secrets.save(transaction, identity.directory.secret),
          }
        : null;

      const management = await saveSsoProvider(
        transaction,
        configuration,
        encryptionKey,
        organizationId,
        identity,
        discovered,
        credential,
      );

      const saved = identity
        ? identitySettings.parse({
            provider: identity.provider,
            domain: identity.domain,
            management,
            apps,
            directory,
          })
        : null;

      await transaction
        .update(organizationSettings)
        .set({
          settings: installationSettings.parse({
            identity: saved,
            externallyManaged: next.externallyManaged,
          }),
        })
        .where(eq(organizationSettings.organizationId, organizationId));

      const referenced = [saved?.management, saved?.apps, saved?.directory].flatMap((client) =>
        client?.secret.type === "stored" ? [client.secret.id] : [],
      );

      await transaction
        .delete(organizationSecrets)
        .where(
          and(
            eq(organizationSecrets.organizationId, organizationId),
            notInArray(organizationSecrets.id, referenced),
          ),
        );
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
    initialize: async (input: z.infer<typeof settingsInput>) => {
      await prepare(input);

      return save(input);
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
      const next = { identity: input.identity, externallyManaged: input.externallyManaged };
      const plan = await prepare(next);

      if (plan.restartRequired && !input.acknowledgeRestart)
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
      const provider = await readSsoProvider(database, organizationId);

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
      const provider = await readSsoProvider(database, organizationId);

      if (!provider)
        throw new InvalidOperation({
          code: "BAD_REQUEST",
          message: "Save the company SSO configuration first",
        });
      await auth.api.verifyDomain({ headers, body: { providerId: provider.providerId } });
      revision.value++;
      await inspect(true);

      return { success: true };
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
      const proof = companyLoginRevision({ ...configuration, IDENTITY: resolved.identity });

      if (!proof || !state.settings.identity || current?.session.companyConfiguration !== proof)
        throw new InvalidOperation({
          code: "CONFLICT",
          message: "Sign in with the linked company account to confirm administrator access first",
        });
      await database.transaction(async (transaction) => {
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

      return inspect();
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
    createOwner: async (input: z.infer<typeof setupOwner>) => {
      const owner = await createInstallationOwner(database, input);

      return owner;
    },
    publish: (organizationId = installationOrganizationId) => scoped(organizationId).inspect(true),
    initialize: (
      input: z.infer<typeof settingsInput>,
      organizationId = installationOrganizationId,
    ) => scoped(organizationId).initialize(input),
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
    complete: (principal: Principal, auth: Authentication, headers: Headers) =>
      scoped(principal.application.organizationId).complete(principal, auth, headers),
  };
};
