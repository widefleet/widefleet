import {
  identitySettings,
  installationSettings,
  settingsInput,
  settingsUpdate,
} from "@platform/contracts";
import { and, eq, inArray, isNull, ne, notInArray, sql } from "drizzle-orm";
import { z } from "zod";
import { appSsoConfiguration } from "../../../tools/edge-configuration.ts";
import {
  appCallbackUrl,
  authBundleIssuer,
  buildAuthBundle,
  publishAuthBundle,
  readActivation,
  readActiveAuthBundle,
} from "./auth-bundle.ts";
import { companyAccountProvider, companyIdentity } from "./company-identity.ts";
import { projectAppAccess } from "./app-access.ts";
import { companyLoginRevision, type Authentication } from "./auth.ts";
import type { Configuration } from "./config.ts";
import type { Database } from "./database.ts";
import type { Principal } from "./identity.ts";
import { InvalidOperation } from "./errors.ts";
import { createInstallationSecrets } from "./installation-secrets.ts";
import { installationId, readInstallation } from "./installation-store.ts";
import { session, oauthRefreshToken } from "./auth-schema.ts";
import { apps, installation, installationSecrets } from "./schema.ts";

const requireAdmin = (principal: Principal) => {
  if (!principal.admin)
    throw new InvalidOperation({
      code: "FORBIDDEN",
      message: "Platform administrator access is required",
    });
};

export const createSettingsService = (
  configuration: Configuration,
  database: Database,
  encryptionKey: string,
  cookieSecret: string,
) => {
  const secrets = createInstallationSecrets(database, encryptionKey);

  const reconcileAppAccess = async () => {
    const active = await readActiveAuthBundle(configuration);

    if (!active) return;
    const issuer = authBundleIssuer(active);

    const affected = (provider: string) =>
      and(isNull(apps.parentId), ne(apps.state, "deleting"), ne(apps.accessProvider, provider));

    const [pending] = await database
      .select({ id: apps.id })
      .from(apps)
      .where(affected(issuer))
      .limit(1);

    if (!pending) return;
    await database.transaction(async (transaction) => {
      // Serialize with settings saves, app creation and role writes. The active
      // bundle is published only after SSO starts successfully, and survives a
      // failed replacement. Re-read it after waiting for the lock.
      await transaction
        .select({ id: installation.id })
        .from(installation)
        .where(eq(installation.id, installationId))
        .for("update");
      const current = await readActiveAuthBundle(configuration);

      if (!current) return;
      const provider = authBundleIssuer(current);

      const originals = await transaction
        .select()
        .from(apps)
        .where(affected(provider))
        .orderBy(apps.id)
        .for("update");

      for (const app of originals) {
        const projected = await projectAppAccess(transaction, app, provider);

        if (projected.isErr()) throw projected.error;
      }
    });
  };

  const resolveCurrent = (force = false) =>
    database.transaction(
      async (transaction) => {
        const snapshotSecrets = createInstallationSecrets(transaction, encryptionKey);

        const state = await readInstallation(transaction);
        const identity = state.settings.identity;

        if (!identity) return { state, identity: null, error: null, revision: "" };

        let resolved: z.infer<typeof companyIdentity> | null = null;
        let revision = "";
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

        try {
          const bundle = buildAuthBundle(
            configuration,
            identity,
            await snapshotSecrets.resolve(identity.apps.secret),
            cookieSecret,
          );

          await publishAuthBundle(configuration, bundle, force);
          revision = bundle.revision;
        } catch (cause) {
          errors.push(
            cause instanceof InvalidOperation ? cause.message : "App sign-in could not be prepared",
          );
        }

        return {
          state,
          identity: resolved,
          error: errors.length ? errors.join(". ") : null,
          revision,
        };
      },
      { isolationLevel: "repeatable read", accessMode: "read only" },
    );

  // Every request uses the same publisher. A queued read
  // starts after the preceding publication, so an older read cannot overwrite a completed save.
  let publication = Promise.resolve();

  const resolve = (force = false) => {
    const result = publication.then(async () => {
      const resolved = await resolveCurrent(force);
      await reconcileAppAccess();

      return resolved;
    });

    publication = result.then(
      () => undefined,
      () => undefined,
    );

    return result;
  };

  const inspect = async (force = false) => {
    const resolved = await resolve(force);
    const current = await readActivation(configuration);

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
      localPasswordEnabled: resolved.state.localPasswordEnabled,
      managementCallbackUrl: identity
        ? `${configuration.PLATFORM_URL}/api/auth/callback/${companyAccountProvider(identity)}`
        : null,
      appCallbackUrl: appCallbackUrl(configuration),
      activation,
      error: resolved.error,
    };
  };

  const prepare = async (input: z.infer<typeof settingsInput>) => {
    const next = settingsInput.parse(input);
    const state = await readInstallation(database);

    if ((!state.localPasswordEnabled || state.settings.identity) && !next.identity)
      throw new InvalidOperation({
        code: "BAD_REQUEST",
        message: "Configure a replacement company login before removing the active provider",
      });

    if (next.identity) {
      await secrets.resolve(next.identity.management.secret);
      await secrets.resolve(next.identity.apps.secret);

      if (next.identity.directory) await secrets.resolve(next.identity.directory.secret);
    }

    const active = await readActiveAuthBundle(configuration);

    const nextProxy = next.identity
      ? appSsoConfiguration(
          next.identity.provider,
          next.identity.apps.clientId,
          "/runtime/client-secret",
        )
      : null;

    const restartRequired =
      active !== null && JSON.stringify(active.proxy) !== JSON.stringify(nextProxy);

    return {
      restartRequired,
      message: restartRequired
        ? "This change restarts the sign-in service. Requests to published apps may fail temporarily, including for signed-in users."
        : "This change can be applied without restarting the sign-in service.",
    };
  };

  const save = async (input: z.infer<typeof settingsInput>) => {
    const next = settingsInput.parse(input);
    await database.transaction(async (transaction) => {
      // Keep replacing references and removing unused secret rows in one ordered transaction.
      await transaction
        .select({ id: installation.id })
        .from(installation)
        .where(eq(installation.id, installationId))
        .for("update");
      const identity = next.identity;

      const saved = identity
        ? identitySettings.parse({
            provider: identity.provider,
            management: {
              clientId: identity.management.clientId,
              secret: await secrets.save(transaction, identity.management.secret),
            },
            apps: {
              clientId: identity.apps.clientId,
              secret: await secrets.save(transaction, identity.apps.secret),
            },
            directory: identity.directory
              ? {
                  clientId: identity.directory.clientId,
                  secret: await secrets.save(transaction, identity.directory.secret),
                }
              : null,
          })
        : null;

      await transaction
        .update(installation)
        .set({
          settings: installationSettings.parse({
            identity: saved,
            externallyManaged: next.externallyManaged,
          }),
        })
        .where(eq(installation.id, installationId));

      const referenced = [saved?.management, saved?.apps, saved?.directory].flatMap((client) =>
        client?.secret.type === "stored" ? [client.secret.id] : [],
      );

      await transaction
        .delete(installationSecrets)
        .where(notInArray(installationSecrets.id, referenced));
    });

    return inspect(true);
  };

  return {
    resolve,
    inspect,
    initialize: async (input: z.infer<typeof settingsInput>) => {
      await prepare(input);

      return save(input);
    },
    read: async (principal: Principal) => {
      requireAdmin(principal);

      return inspect();
    },
    plan: async (principal: Principal, input: z.infer<typeof settingsInput>) => {
      requireAdmin(principal);

      return prepare(input);
    },
    update: async (
      principal: Principal,
      input: z.infer<typeof settingsUpdate>,
      browser: boolean,
    ) => {
      requireAdmin(principal);
      const state = await readInstallation(database);

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

      return save(next);
    },
    setExternalManagement: async (principal: Principal, enabled: boolean) => {
      requireAdmin(principal);
      await database
        .update(installation)
        .set({
          settings: sql`jsonb_set(${installation.settings}, '{externallyManaged}', to_jsonb(${enabled}::boolean))`,
        })
        .where(eq(installation.id, installationId));

      return inspect();
    },
    complete: async (principal: Principal, auth: Authentication, headers: Headers) => {
      requireAdmin(principal);
      const current = await auth.api.getSession({ headers });
      const state = await readInstallation(database);

      const resolved = await resolve();
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
          .where(eq(session.companyConfiguration, ""));

        await transaction
          .delete(oauthRefreshToken)
          .where(inArray(oauthRefreshToken.sessionId, localSessions));
        await transaction.delete(session).where(eq(session.companyConfiguration, ""));
      });

      return inspect();
    },
  };
};
